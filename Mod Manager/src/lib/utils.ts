import { OptionType, type Config, type Manifest } from "../../../src/types"
import { compileExpression, useDotAccessOperatorAndOptionalChaining } from "filtrex"

import Ajv from "ajv"
import json5 from "json5"
import manifestSchema from "$lib/manifest-schema.json"
import entitySchema from "$lib/entity-schema.json"
import entityPatchSchema from "$lib/entity-patch-schema.json"
import repositorySchema from "$lib/repository-schema.json"
import unlockablesSchema from "$lib/unlockables-schema.json"
import contractSchema from "$lib/contract-schema.json"
import jsonPatchSchema from "$lib/json-patch-schema.json"
import memoize from "lodash.memoize"
import merge from "lodash.mergewith"
import semver from "semver"
import { writable } from "svelte/store"

export const FrameworkVersion = "2.33.40"

let cachedConfig: Config | null = null
let loadOrderValidated = false
export const configStore = writable<Config | null>(null)

const validateManifest = new Ajv({ strict: false }).compile(manifestSchema)

const validateEntity = new Ajv({ strict: false }).compile(entitySchema)
const validateEntityPatch = new Ajv({ strict: false }).compile(entityPatchSchema)
const validateRepository = new Ajv({ strict: false }).compile(repositorySchema)
const validateUnlockables = new Ajv({ strict: false }).compile(unlockablesSchema)
const validateContract = new Ajv({ strict: false }).compile(contractSchema)
const validateJSONPatch = new Ajv({ strict: false }).compile(jsonPatchSchema)

export function getConfig() {
	if (cachedConfig && loadOrderValidated) {
		configStore.set(cachedConfig)
		return cachedConfig
	}

	const config: Config = json5.parse(String(window.fs.readFileSync("../config.json", "utf8")))

	config.knownMods = config.knownMods || []
	config.developerMode = config.developerMode || false

	// Remove duplicate items in load order
	config.loadOrder = config.loadOrder.filter((value, index, array) => array.indexOf(value) === index)

	if (modsCacheInitialized) {
		// Remove non-existent mods from load order
		config.loadOrder = config.loadOrder.filter((value) => {
			try {
				getModFolder(value)
				return true
			} catch {
				return false
			}
		})
		loadOrderValidated = true
	}

	// Validate mod options
	config.loadOrder.forEach((mod) => {
		if (modIsFramework(mod)) {
			const manifest = getManifestFromModID(mod)!

			if (manifest.options) {
				if (!config.modOptions[mod]) {
					merge(
						config,
						{
							modOptions: {
								[mod]: [
									...manifest.options
										.filter((a) => (a.type === "checkbox" || a.type === "select" ? a.enabledByDefault : false))
										.map((a) => (a.type === "select" ? `${a.group}:${a.name}` : a.name))
								]
							}
						},
						(orig, src) => {
							if (Array.isArray(orig)) {
								return src
							}
						}
					)
				} // Select default options when a mod has no options set

				config.modOptions[mod].push(
					...manifest.options
						.filter((a) => a.type === "select" && a.enabledByDefault)
						.filter((a) => !config.modOptions[mod].some((b) => b.split(":").length > 1 && b.split(":")[0] !== a.name))
						.map((a) => (a.type === "select" ? `${a.group}:${a.name}` : a.name))
				) // Select default options in select type IF there is no selected option

				for (let i = config.modOptions[mod].length - 1; i >= 0; i--) {
					if (
						!(
							manifest.options.some((a) => a.type === "checkbox" && a.name === config.modOptions[mod][i]) ||
							manifest.options.some((a) => a.type === "select" && `${a.group}:${a.name}` === config.modOptions[mod][i])
						)
					) {
						if (manifest.options.some((a) => a.type === "select" && a.name === config.modOptions[mod][i])) {
							// There's a select and it's using the old name format (just the name), change it to the new format (group:name)
							config.modOptions[mod][i] =
								// @ts-expect-error TypeScript doesn't think that a select has a group apparently
								`${
									// @ts-expect-error TypeScript doesn't think that a select has a group apparently
									manifest.options.find((a) => a.type === "select" && a.name === config.modOptions[mod][i])!.group
								}:${manifest.options.find((a) => a.type === "select" && a.name === config.modOptions[mod][i])!.name}`
						} else {
							// Remove it, it doesn't exist
							config.modOptions[mod].splice(i, 1)
						}
					}
				} // Remove non-existent options and update from the old name format in select options

				for (let i = config.modOptions[manifest.id].length - 1; i >= 0; i--) {
					if (
						manifest.options.find(
							(a) => (a.type === "checkbox" && a.name === config.modOptions[manifest.id][i]) || (a.type === "select" && `${a.group}:${a.name}` === config.modOptions[manifest.id][i])
						)?.requirements
					) {
						if (
							!manifest.options
								.find(
									(a) =>
										(a.type === "checkbox" && a.name === config.modOptions[manifest.id][i]) || (a.type === "select" && `${a.group}:${a.name}` === config.modOptions[manifest.id][i])
								)!
								.requirements!.every((a) => config.loadOrder.includes(a))
						) {
							config.modOptions[manifest.id].splice(i, 1)
						}
					}
				} // Disable mod options that require non-present mods

				merge(
					config,
					{
						modOptions: config.modOptions
					},
					(orig, src) => {
						if (Array.isArray(orig)) {
							return src
						}
					}
				)
			}
		}
	})

	setConfig(config)
	return config
}

export function setConfig(config: Config) {
	cachedConfig = config
	loadOrderValidated = modsCacheInitialized
	configStore.set(config)
	window.fs.writeFileSync("../config.json", json5.stringify(config))
}

export function mergeConfig(configToMerge: Partial<Config>) {
	const config = getConfig()
	setConfig(
		merge(config, configToMerge, (orig, src) => {
			if (Array.isArray(orig)) {
				return src
			}
		})
	)
}

export function sortMods() {
	const config = getConfig()

	config.loadOrder = config.loadOrder.sort((a, b) => {
		// RPKG mod sort order does not matter; they're always deployed before framework mods anyway
		if (!(modIsFramework(a) && modIsFramework(b))) {
			return 0
		}

		const manifestA = getManifestFromModID(a)
		const manifestB = getManifestFromModID(b)

		const modALoadBefore: (string | [string, string])[] = []

		if (manifestA.loadBefore) {
			modALoadBefore.push(...manifestA.loadBefore)
		}

		if (manifestA.options) {
			modALoadBefore.push(
				...(manifestA.options
					.filter(
						(x) =>
							config.modOptions[a].includes(x.name) ||
							config.modOptions[a].includes(`${x.group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadBefore)
					.filter((a) => a)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modBLoadBefore: (string | [string, string])[] = []

		if (manifestB.loadBefore) {
			modBLoadBefore.push(...manifestB.loadBefore)
		}

		if (manifestB.options) {
			modBLoadBefore.push(
				...(manifestB.options
					.filter(
						(x) =>
							config.modOptions[b].includes(x.name) ||
							config.modOptions[b].includes(`${x.group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadBefore)
					.filter((a) => a!)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modALoadAfter: (string | [string, string])[] = []

		if (manifestA.loadAfter) {
			modALoadAfter.push(...manifestA.loadAfter)
		}

		if (manifestA.options) {
			modALoadAfter.push(
				...(manifestA.options
					.filter(
						(x) =>
							config.modOptions[a].includes(x.name) ||
							config.modOptions[a].includes(`${x.group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadAfter)
					.filter((a) => a)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modBLoadAfter: (string | [string, string])[] = []

		if (manifestB.loadAfter) {
			modBLoadAfter.push(...manifestB.loadAfter)
		}

		if (manifestB.options) {
			modBLoadAfter.push(
				...(manifestB.options
					.filter(
						(x) =>
							config.modOptions[b].includes(x.name) ||
							config.modOptions[b].includes(`${x.group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadAfter)
					.filter((a) => a!)
					.flat(1) as (string | [string, string])[])
			)
		}

		for (const loadBefore of modALoadBefore) {
			if (typeof loadBefore === "string") {
				if (loadBefore === b) {
					return -1
				}
			} else if (loadBefore[0] === b) {
				if (semver.satisfies(manifestB.version, loadBefore[1])) {
					return -1
				}
			}
		}

		for (const loadAfter of modALoadAfter) {
			if (typeof loadAfter === "string") {
				if (loadAfter === b) {
					return 1
				}
			} else if (loadAfter[0] === b) {
				if (semver.satisfies(manifestB.version, loadAfter[1])) {
					return 1
				}
			}
		}

		for (const loadBefore of modBLoadBefore) {
			if (typeof loadBefore === "string") {
				if (loadBefore === a) {
					return 1
				}
			} else if (loadBefore[0] === a) {
				if (semver.satisfies(manifestB.version, loadBefore[1])) {
					return 1
				}
			}
		}

		for (const loadAfter of modBLoadAfter) {
			if (typeof loadAfter === "string") {
				if (loadAfter === a) {
					return -1
				}
			} else if (loadAfter[0] === a) {
				if (semver.satisfies(manifestB.version, loadAfter[1])) {
					return -1
				}
			}
		}

		return 0
	})

	setConfig(config)
	return true
}

export function alterModManifest(modID: string, data: Partial<Manifest>) {
	const manifest = getManifestFromModID(modID)
	merge(manifest, data, (orig, src) => {
		if (Array.isArray(orig)) {
			return src
		}
	})
	setModManifest(modID, manifest)
}

let modsCacheInitialized = false
let modsList: string[] = []
const manifestsMap = new Map<string, Manifest>()
const foldersMap = new Map<string, string>()
const isFrameworkMap = new Map<string, boolean>()

export function clearModsCache() {
	modsCacheInitialized = false
	loadOrderValidated = false
	cachedConfig = null
	preloadModsCache("clearModsCache", true)
}

export let cacheLoadStartTimestamp: number | null = null
export let cacheLoadStartCaller: string | null = null

let cacheGeneration = 0
let cacheLoadingPromise: Promise<void> | null = null

export function preloadModsCache(caller?: string, force = false): Promise<void> {
	if (modsCacheInitialized && !force) {
		return Promise.resolve()
	}
	if (cacheLoadingPromise && !force) {
		return cacheLoadingPromise
	}

	cacheLoadStartTimestamp = Date.now()
	cacheLoadStartCaller = caller || "unknown"

	const currentGeneration = ++cacheGeneration

	cacheLoadingPromise = (async () => {
		try {
			const modsDir = window.path.join("..", "Mods")
			if (!(await window.fs.pathExists(modsDir))) {
				if (currentGeneration !== cacheGeneration) {
					await cacheLoadingPromise
					return
				}
				modsList = []
				manifestsMap.clear()
				foldersMap.clear()
				isFrameworkMap.clear()
				modsCacheInitialized = true
				return
			}

			const subdirs = await window.fs.readdir(modsDir)
			const tempModsList: string[] = []
			const tempManifestsMap = new Map<string, Manifest>()
			const tempFoldersMap = new Map<string, string>()
			const tempIsFrameworkMap = new Map<string, boolean>()

			for (const subdir of subdirs) {
				if (subdir === "Managed by SMF, do not touch") {
					continue
				}

				const fullPath = window.path.resolve(window.path.join(modsDir, subdir))
				const manifestPath = window.path.join(fullPath, "manifest.json")

				if (await window.fs.pathExists(manifestPath)) {
					try {
						const manifestContent = await window.fs.readFile(manifestPath, "utf8")
						const manifest = json5.parse(String(manifestContent)) as Manifest
						const id = manifest.id
						if (id) {
							tempModsList.push(id)
							tempManifestsMap.set(id, manifest)
							tempFoldersMap.set(id, fullPath)
							tempIsFrameworkMap.set(id, true)
						} else {
							const idFallback = subdir
							tempModsList.push(idFallback)
							tempFoldersMap.set(idFallback, fullPath)
							tempIsFrameworkMap.set(idFallback, false)
						}
					} catch (e) {
						const idFallback = subdir
						tempModsList.push(idFallback)
						tempFoldersMap.set(idFallback, fullPath)
						tempIsFrameworkMap.set(idFallback, false)
					}
				} else {
					const id = subdir
					tempModsList.push(id)
					tempFoldersMap.set(id, fullPath)
					tempIsFrameworkMap.set(id, false)
				}
			}

			if (currentGeneration !== cacheGeneration) {
				await cacheLoadingPromise
				return
			}

			// Swap double-buffered cache
			modsList = tempModsList
			manifestsMap.clear()
			tempManifestsMap.forEach((v, k) => manifestsMap.set(k, v))
			foldersMap.clear()
			tempFoldersMap.forEach((v, k) => foldersMap.set(k, v))
			isFrameworkMap.clear()
			tempIsFrameworkMap.forEach((v, k) => isFrameworkMap.set(k, v))
			modsCacheInitialized = true
		} catch (err) {
			if (currentGeneration === cacheGeneration) {
				console.error("Failed to preload mods cache:", err)
			}
		} finally {
			if (currentGeneration === cacheGeneration) {
				cacheLoadingPromise = null
			}
		}
	})()

	return cacheLoadingPromise
}

export function initializeModsCache() {
	if (modsCacheInitialized) {
		return
	}
	console.warn("[WARNING] Mods cache is not initialized. Performing synchronous disk scan fallback in initializeModsCache().")

	modsList = []
	manifestsMap.clear()
	foldersMap.clear()
	isFrameworkMap.clear()

	const modsDir = window.path.join("..", "Mods")
	if (!window.fs.existsSync(modsDir)) {
		modsCacheInitialized = true
		return
	}

	const subdirs = window.fs.readdirSync(modsDir)
	for (const subdir of subdirs) {
		if (subdir === "Managed by SMF, do not touch") {
			continue
		}

		const fullPath = window.path.resolve(window.path.join(modsDir, subdir))
		const manifestPath = window.path.join(fullPath, "manifest.json")

		if (window.fs.existsSync(manifestPath)) {
			try {
				const manifestContent = window.fs.readFileSync(manifestPath, "utf8")
				const manifest = json5.parse(String(manifestContent)) as Manifest
				const id = manifest.id
				if (id) {
					modsList.push(id)
					manifestsMap.set(id, manifest)
					foldersMap.set(id, fullPath)
					isFrameworkMap.set(id, true)
				} else {
					const idFallback = subdir
					modsList.push(idFallback)
					foldersMap.set(idFallback, fullPath)
					isFrameworkMap.set(idFallback, false)
				}
			} catch (e) {
				const idFallback = subdir
				modsList.push(idFallback)
				foldersMap.set(idFallback, fullPath)
				isFrameworkMap.set(idFallback, false)
			}
		} else {
			const id = subdir
			modsList.push(id)
			foldersMap.set(id, fullPath)
			isFrameworkMap.set(id, false)
		}
	}

	modsCacheInitialized = true
}

export function setModManifest(modID: string, manifest: Manifest) {
	window.fs.writeFileSync(window.path.join(getModFolder(modID), "manifest.json"), JSON.stringify(manifest, undefined, "\t"))
	clearValidationCache()
	clearModsCache()
}

export function getModFolder(id: string): string {
	initializeModsCache()
	const cachedFolder = foldersMap.get(id)
	if (cachedFolder) {
		return cachedFolder
	}

	console.warn(`[WARNING] Cache miss for mod folder ID: ${id}. Performing synchronous fallback directory search.`)
	const folder = modIsFramework(id)
		? window.fs
				.readdirSync(window.path.join("..", "Mods"))
				.find(
					(a) =>
						window.fs.existsSync(window.path.join("..", "Mods", a, "manifest.json")) &&
						json5.parse(String(window.fs.readFileSync(window.path.join("..", "Mods", a, "manifest.json"), "utf8"))).id === id
				)
		: id

	if (!folder) {
		window.alert(`The mod ${id} couldn't be located! This will likely cause issues in parts of the framework. If you deleted a mod folder, use the Delete Mod option next time.`)
		throw new Error(`Couldn't find mod ${id}`)
	}

	return window.path.resolve(window.path.join("..", "Mods", folder))
}

export function modIsFramework(id: string): boolean {
	initializeModsCache()
	const cachedValue = isFrameworkMap.get(id)
	if (cachedValue !== undefined) {
		return cachedValue
	}

	const modPath = window.path.join("..", "Mods", id)
	if (window.fs.existsSync(modPath)) {
		return window.fs.existsSync(window.path.join(modPath, "manifest.json"))
	}
	return true
}

export function getManifestFromModID(id: string, dummy = 1): Manifest {
	initializeModsCache()
	const cachedManifest = manifestsMap.get(id)
	if (cachedManifest) {
		return cachedManifest
	}

	console.warn(`[WARNING] Cache miss for manifest ID: ${id}. Performing synchronous fallback file read.`)
	if (modIsFramework(id)) {
		return json5.parse(String(window.fs.readFileSync(window.path.join(getModFolder(id), "manifest.json"), "utf8")))
	} else {
		throw new Error(`Mod ${id} is not a framework mod`)
	}
}

export function getAllMods(): string[] {
	initializeModsCache()
	return [...modsList]
}

const validationCache = new Map<string, [boolean, string]>()

export function clearValidationCache() {
	validationCache.clear()
}

export function validateModFolder(modFolder: string): [boolean, string] {
	if (validationCache.has(modFolder)) {
		return validationCache.get(modFolder)!
	}

	const result = performValidation(modFolder)
	validationCache.set(modFolder, result)
	return result
}

function performValidation(modFolder: string): [boolean, string] {
	if (!window.fs.existsSync(window.path.join(modFolder, "manifest.json"))) {
		return [false, "No manifest"]
	}

	try {
		json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8"))
	} catch {
		return [false, "Invalid manifest due to invalid JSON"]
	}

	if (!validateManifest(json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8")))) {
		return [false, `Invalid manifest due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateManifest.errors)}`]
	}

	const manifest: Manifest = json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8"))

	for (const contentFolder of [...(manifest.contentFolders || []), ...(manifest.options || []).flatMap((a) => a.contentFolders || [])]) {
		if (!window.fs.existsSync(window.path.resolve(modFolder, contentFolder))) {
			return [false, `Invalid content folder "${contentFolder}" due to nonexistent path`]
		}

		const chunkFolders = window.fs.readdirSync(window.path.resolve(modFolder, contentFolder))

		if (chunkFolders.length === 0) {
			return [false, `Empty content folder "${contentFolder}"`]
		}

		for (const chunkFolder of chunkFolders) {
			if (!chunkFolder.match(/chunk([0-9]*)/)) {
				return [false, `Invalid chunk folder "${chunkFolder}" in "${contentFolder}"`]
			}
		}
	}

	for (const blobsFolder of [...(manifest.blobsFolders || []), ...(manifest.options || []).flatMap((a) => a.blobsFolders || [])]) {
		if (!window.fs.existsSync(window.path.resolve(modFolder, blobsFolder))) {
			return [false, `Invalid blobs folder "${blobsFolder}" due to nonexistent path`]
		}

		if (window.fs.readdirSync(window.path.resolve(modFolder, blobsFolder)).length === 0) {
			return [false, `Empty blobs folder "${blobsFolder}"`]
		}
	}

	const groups: Record<string, [number, number]> = {}

	for (const option of manifest.options || []) {
		if (option.type === OptionType.select) {
			groups[option.group] ??= [0, 0]
			groups[option.group][0] = groups[option.group][0] + 1

			if (option.enabledByDefault) {
				groups[option.group][1] = groups[option.group][1] + 1
			}
		}
	}

	for (const [group, [members, enabledByDefault]] of Object.entries(groups)) {
		if (members === 1) {
			return [false, `Option group "${group}" has only one member`]
		}

		if (enabledByDefault > 1) {
			return [false, `Option group "${group}" has more than one member enabled by default`]
		}
	}

	for (const file of window.klaw(modFolder, { nodir: true }).map((a) => a.path)) {
		if (
			file.endsWith("entity.json") ||
			file.endsWith("entity.patch.json") ||
			file.endsWith("repository.json") ||
			file.endsWith("unlockables.json") ||
			file.endsWith("JSON.patch.json") ||
			file.endsWith("contract.json")
		) {
			try {
				const fileContents = window.fs.readJSONSync(file)

				switch (file.split(".").slice(1).join(".")) {
					case "entity.json":
						if (fileContents.quickEntityVersion === 3.1 && !validateEntity(fileContents))
							return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateEntity.errors)}`]
						break
					case "entity.patch.json":
						if (fileContents.patchVersion === 6 && !validateEntityPatch(fileContents))
							return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateEntityPatch.errors)}`]
						break
					case "repository.json":
						if (!validateRepository(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateRepository.errors)}`]
						break
					case "unlockables.json":
						if (!validateUnlockables(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateUnlockables.errors)}`]
						break
					case "contract.json":
						if (!validateContract(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateContract.errors)}`]
						break
					case "JSON.patch.json":
						if (!validateJSONPatch(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateJSONPatch.errors)}`]
						break
				}
			} catch {
				return [false, `Invalid file ${file} due to invalid JSON`]
			}
		}
	}

	return [true, ""]
}
