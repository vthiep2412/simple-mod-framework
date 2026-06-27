<script lang="ts">
	import { scale, fade } from "svelte/transition"
	import { flip } from "svelte/animate"
	import { onMount } from "svelte"

	import json5 from "json5"
	import { Button, CodeSnippet, InlineNotification, Modal, ProgressBar, Search, InlineLoading } from "carbon-components-svelte"
	import AnsiToHTML from "ansi-to-html"
	import throttle from "lodash/throttle"

	const convertAnsi = new AnsiToHTML({
		newline: true,
		escapeXML: true,
		colors: {
			// Qualia by u/starlig-ht, slightly modified for background colour
			"0": "#101010",
			"1": "#EFA6A2",
			"2": "#80C990",
			"3": "#C8C874",
			"4": "#A3B8EF",
			"5": "#E6A3DC",
			"6": "#50CACD",
			"7": "#808080",
			"8": "#878787",
			"9": "#E0AF85",
			"10": "#5ACCAF",
			"11": "#C8C874",
			"12": "#CCACED",
			"13": "#F2A1C2",
			"14": "#74C3E4",
			"15": "#C0C0C0"
		},
		fg: "#f4f4f4",
		bg: "#262626"
	})

	import { getAllMods, getConfig, mergeConfig, getManifestFromModID, modIsFramework, getModFolder, sortMods, validateModFolder, clearModsCache, clearValidationCache, preloadModsCache } from "$lib/utils"
	import Mod from "$lib/Mod.svelte"
	import TextInputModal from "$lib/TextInputModal.svelte"
	import { goto } from "$app/navigation"

	import Add from "carbon-icons-svelte/lib/Add.svelte"
	import AddAlt from "carbon-icons-svelte/lib/AddAlt.svelte"
	import SubtractAlt from "carbon-icons-svelte/lib/SubtractAlt.svelte"
	import Rocket from "carbon-icons-svelte/lib/Rocket.svelte"
	import Settings from "carbon-icons-svelte/lib/Settings.svelte"
	import TrashCan from "carbon-icons-svelte/lib/TrashCan.svelte"
	import Close from "carbon-icons-svelte/lib/Close.svelte"
	import CloudUpload from "carbon-icons-svelte/lib/CloudUpload.svelte"
	import Filter from "carbon-icons-svelte/lib/Filter.svelte"
	import { OptionType } from "../../../../src/types"
	import { page } from "$app/stores"
	import SortableList from "$lib/SortableList.svelte"

	let enabledMods: { value: string }[] = []
	let disabledMods: { value: string }[] = []
	let cacheLoaded = false
	let deleteModModalOpen = false
	let deleteModInProgress: string
	let forceModListsUpdate = Math.random()

	onMount(async () => {
		await preloadModsCache("modList")
		cacheLoaded = true
	})

	$: if (cacheLoaded) {
		if (!getConfig().developerMode) {
			// If no mods are known
			if (getConfig().knownMods.length == 0) {
				// Assume all mods are installed correctly
				mergeConfig({ knownMods: getAllMods() })
			}

			for (const mod of getAllMods()) {
				if (!getConfig().knownMods.includes(mod)) {
					extractedMods.push(getManifestFromModID(mod).name)
					displayExtractedModsDialog = true

					mergeConfig({ knownMods: [...getConfig().knownMods, mod] })
				}
			}
		}

		enabledMods = getConfig().loadOrder.map((a) => {
			return { value: a, dummy: forceModListsUpdate }
		})

		disabledMods = getAllMods()
			.filter((a) => !getConfig().loadOrder.includes(a))
			.sort((a, b) => (modIsFramework(a) ? getManifestFromModID(a).name : a).localeCompare(modIsFramework(b) ? getManifestFromModID(b).name : b, undefined, { numeric: true, sensitivity: "base" }))
			.map((a) => {
				return { value: a, dummy: forceModListsUpdate }
			})
	}

	let changed = false

	let showDropHint = false
	let dependencyCycleModalOpen = false
	let frameworkDeployModalOpen = false
	let deployOutput = ""
	let deployOutputHTML = ""
	let deployDiagnostics: string[] = []
	let deployFinished = false

	window.ipc.receive("frameworkDeployModalOpen", () => {
		frameworkDeployModalOpen = true
	})

	const convertOutputToHTML = throttle(() => {
		deployOutputHTML = convertAnsi.toHtml(deployOutput)

		if (deployDiagnostics.length < 20) {
			deployDiagnostics = deployOutput.split(/\r?\n/).filter((a) => a.match(/.*WARN.*?\t/) || a.match(/.*ERROR.*?\t/))
		}

		setTimeout(() => {
			document.getElementById("deployOutputElement")?.children[0].scrollIntoView(false)
		}, 100)
	}, 500)

	window.ipc.receive("frameworkDeployOutput", (output: string) => {
		deployOutput = output
		convertOutputToHTML()
	})

	window.ipc.receive("frameworkDeployFinished", () => {
		deployFinished = true
	})

	document.addEventListener("drop", (event) => {
		event.preventDefault()
		event.stopPropagation()
		showDropHint = false
		if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			const paths = Array.from(event.dataTransfer.files).map((f: any) => f.path)
			stageFiles(paths)
		}
	})
	document.addEventListener("dragover", (event) => {
		event.preventDefault()
		event.stopPropagation()
	})
	document.addEventListener("dragenter", (event) => {
		if ((event.dataTransfer?.items?.length ?? 0) > 0 && event.dataTransfer?.items[0]?.kind === "file") showDropHint = true
	})
	document.addEventListener("dragleave", (event) => {
		if (event.relatedTarget == null) showDropHint = false
	})

	let bulkImportModalOpen = false
	let stageInProgress = false
	let currentStagingRunId = 0
	let stagedMods: Array<{
		id: string
		fileName: string
		filePath: string
		stageDir: string
		type: "framework" | "rpkg" | "unknown"
		status: "valid" | "warning" | "invalid"
		errors: string[]
		warnings: string[]
		mods: Array<{
			id: string
			name: string
			folder: string
			isFramework: boolean
			rpkgs?: Array<{ path: string; chunk: string }>
		}>
		rpkgNameInput?: string
	}> = []

	function execFileAsync(file: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			window.child_process.execFile(file, args, (error: any, stdout: any, stderr: any) => {
				if (error) {
					reject(error)
				} else {
					resolve(stdout)
				}
			})
		})
	}

	function sanitizeModName(name: string): string {
		let sanitized = name.replace(/[/\\]/g, "")
		sanitized = sanitized.replace(/\.\./g, "")
		sanitized = sanitized.trim()
		if (!sanitized) {
			sanitized = "staged_rpkg_mod"
		}
		return sanitized
	}

	async function stageFiles(filePaths: string[]) {
		stageInProgress = true
		bulkImportModalOpen = true
		stagedMods = []
		const runId = ++currentStagingRunId
		try {
			try {
				window.fs.emptyDirSync("./staging")
			} catch (e) {
				// staging folder might not exist yet
			}

			for (let i = 0; i < filePaths.length; i++) {
				if (runId !== currentStagingRunId) {
					return
				}
				const filePath = filePaths[i]
				const fileName = window.path.basename(filePath)
				const stageDir = window.path.join("./staging", `temp_${i}`)
				window.fs.ensureDirSync(stageDir)

				let type: "framework" | "rpkg" | "unknown" = "unknown"
				let status: "valid" | "warning" | "invalid" = "valid"
				let errors: string[] = []
				let warnings: string[] = []
				let mods: any[] = []
				let rpkgNameInput = ""

				if (filePath.toLowerCase().endsWith(".rpkg")) {
					type = "rpkg"
					status = "valid"
					let chunk = "chunk0"
					let result = [...filePath.matchAll(/(chunk[0-9]*)/g)]
					if (result.length) {
						chunk = result[0][1]
					}
					const destChunkDir = window.path.join(stageDir, chunk)
					window.fs.ensureDirSync(destChunkDir)
					window.fs.copyFileSync(filePath, window.path.join(destChunkDir, fileName))
					
					const cleanName = fileName.replace(/\.rpkg$/i, "")
					rpkgNameInput = cleanName
					mods = [{
						id: cleanName,
						name: cleanName,
						folder: stageDir,
						isFramework: false,
						rpkgs: [{ path: window.path.join(destChunkDir, fileName), chunk }]
					}]
				} else {
				try {
					await execFileAsync("..\\Third-Party\\7z.exe", ["x", filePath, "-aoa", "-y", `-o${stageDir}`])
					if (runId !== currentStagingRunId) {
						return
					}
					
					const rootFiles = window.fs.readdirSync(stageDir)
					const hasFilesAtRoot = window.klaw(stageDir, { depthLimit: 0, nodir: true }).length > 0
					const everySubdirHasManifest = rootFiles.length > 0 && rootFiles.every(a => {
						const fullSubPath = window.path.join(stageDir, a)
						if (!window.isFile(fullSubPath)) {
							return window.fs.existsSync(window.path.join(fullSubPath, "manifest.json"))
						}
						return false
					})

					if (everySubdirHasManifest && !hasFilesAtRoot) {
						type = "framework"
						for (const a of rootFiles) {
							const modFolder = window.path.join(stageDir, a)
							let manifest: any
							try {
								manifest = json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8"))
							} catch (e) {
								status = "invalid"
								errors.push(`Invalid manifest.json syntax in folder "${a}"`)
								continue
							}

							const modValidation = validateModFolder(modFolder)
							if (!modValidation[0]) {
								status = "invalid"
								errors.push(`Validation failed for "${manifest.name || a}": ${modValidation[1]}`)
							} else {
								let modWarning = ""
								if (manifest.scripts || manifest.options?.some((b: any) => b.scripts)) {
									modWarning = "Contains custom scripts"
								}
								if (manifest.peacockPlugins || manifest.options?.some((b: any) => b.peacockPlugins)) {
									if (modWarning) modWarning += ", and peacock plugins"
									else modWarning = "Contains peacock plugins"
								}
								if (modWarning) {
									if (status !== "invalid") {
										status = "warning"
									}
									warnings.push(`${manifest.name || a}: ${modWarning}`)
								}
								mods.push({
									id: manifest.id,
									name: manifest.name,
									folder: modFolder,
									isFramework: true
								})
							}
						}
					} else {
						const stagingFileList = window.klaw(stageDir, { nodir: true })
						const rpkgFiles = stagingFileList.filter(a => a.path.toLowerCase().endsWith(".rpkg"))
						if (rpkgFiles.length > 0) {
							type = "rpkg"
							if (status !== "invalid") {
								status = "valid"
							}
							const cleanName = fileName.replace(/\.(zip|7z|rar)$/i, "")
							rpkgNameInput = cleanName
							
							const rpkgsToInstall: any[] = []
							for (const file of rpkgFiles) {
								let chunk = "chunk0"
								let result = [...file.path.matchAll(/(chunk[0-9]*)/g)]
								if (result.length) {
									chunk = result[0][1]
								}
								rpkgsToInstall.push({ path: file.path, chunk })
							}
							
							mods = [{
								id: cleanName,
								name: cleanName,
								folder: stageDir,
								isFramework: false,
								rpkgs: rpkgsToInstall
							}]
						} else {
							type = "unknown"
							status = "invalid"
							errors.push("No manifest.json or .rpkg files found in archive")
						}
					}
				} catch (err: any) {
					status = "invalid"
					errors.push(`Extraction/Analysis failed: ${err.message || err}`)
				}
			}

			if (runId !== currentStagingRunId) {
				return
			}
			stagedMods.push({
				id: `staged_${Date.now()}_${i}`,
				fileName,
				filePath,
				stageDir,
				type,
				status,
				errors,
				warnings,
				mods,
				rpkgNameInput
			})
			}
			if (runId !== currentStagingRunId) {
				return
			}
			stagedMods = stagedMods
		} finally {
			stageInProgress = false
		}
	}

	async function executeBulkImport() {
		const modsToImport = stagedMods.filter((sm) => sm.status !== "invalid")

		const existingNames: string[] = []
		for (const staged of modsToImport) {
			if (staged.type === "framework") {
				for (const mod of staged.mods) {
					const destFolder = window.path.join("..", "Mods", window.path.basename(mod.folder))
					if (window.fs.existsSync(destFolder)) {
						existingNames.push(window.path.basename(mod.folder))
					}
				}
			} else if (staged.type === "rpkg") {
				const rawName = staged.rpkgNameInput ? staged.rpkgNameInput.trim() : staged.fileName.replace(/\.[^/.]+$/, "")
				const modName = sanitizeModName(rawName)
				const destFolder = window.path.join("..", "Mods", modName)
				if (window.fs.existsSync(destFolder)) {
					existingNames.push(modName)
				}
			}
		}

		if (existingNames.length > 0) {
			const confirm = window.confirm(`The following mods already exist and will be overwritten:\n${existingNames.join(", ")}\n\nDo you want to continue?`)
			if (!confirm) {
				return
			}
		}

		for (const staged of modsToImport) {
			if (staged.type === "framework") {
				for (const mod of staged.mods) {
					const destFolder = window.path.join("..", "Mods", window.path.basename(mod.folder))
					window.fs.copySync(mod.folder, destFolder)

					if (!getConfig().knownMods.includes(mod.id)) {
						mergeConfig({
							knownMods: [...getConfig().knownMods, mod.id]
						})
					}
				}
			} else if (staged.type === "rpkg") {
				const rawName = staged.rpkgNameInput ? staged.rpkgNameInput.trim() : staged.fileName.replace(/\.[^/.]+$/, "")
				const modName = sanitizeModName(rawName)
				
				for (const mod of staged.mods) {
					if (mod.rpkgs) {
						for (const file of mod.rpkgs) {
							const destDir = window.path.join("..", "Mods", modName, file.chunk)
							window.fs.ensureDirSync(destDir)
							window.fs.copyFileSync(file.path, window.path.join(destDir, window.path.basename(file.path)))
						}
					}
				}

				if (!getConfig().knownMods.includes(modName)) {
					mergeConfig({
						knownMods: [...getConfig().knownMods, modName]
					})
				}
			}
		}

		try {
			window.fs.removeSync("./staging")
		} catch (e) {
			// ignore cleanup errors
		}
		
		clearModsCache()
		clearValidationCache()
		
		forceModListsUpdate = Math.random()
		changed = true

		bulkImportModalOpen = false
		stagedMods = []
	}

	function removeStagedMod(id: string) {
		const modToRemove = stagedMods.find((sm) => sm.id === id)
		if (modToRemove) {
			try {
				window.fs.removeSync(modToRemove.stageDir)
			} catch (e) {
				// ignore cleanup errors
			}
		}
		stagedMods = stagedMods.filter((sm) => sm.id !== id)
		if (stagedMods.length === 0) {
			bulkImportModalOpen = false
		}
	}

	function cancelBulkImport() {
		currentStagingRunId++
		for (const staged of stagedMods) {
			try {
				window.fs.removeSync(staged.stageDir)
			} catch (e) {
				// ignore cleanup errors
			}
		}
		try {
			window.fs.removeSync("./staging")
		} catch (e) {
			// ignore cleanup errors
		}
		stagedMods = []
		bulkImportModalOpen = false
	}

	function openAddModDialog() {
		window.ipc.send("modFileOpenDialog")

		window.ipc.receive("modFileOpenDialogResult", (modFilePopupResult: string[] | undefined) => {
			if (!modFilePopupResult || modFilePopupResult.length === 0) {
				return
			}

			stageFiles(modFilePopupResult)
		})
	}

	let displayExtractedModsDialog = false
	const extractedMods: string[] = []

	// Config verification moved to reactive cacheLoaded block to prevent synchronous loading blocks on render

	let uploadedLogURL = ""
	let uploadLogModalOpen = false
	let uploadLogFailedModalOpen = false

	let availableModFilter = ""
	let enabledModFilter = ""

	let autoInstallDownloading = false
	let autoInstallDownloadProgress = 0
	let autoInstallDownloadSize = 0
	let autoInstallModName = ""
	let autoInstallModalOpen = false

	$: if ($page.url.searchParams.get("urlScheme")) {
		;(async () => {
			let chunksAll

			try {
				autoInstallDownloading = true

				const response = await fetch($page.url.searchParams.get("urlScheme")!)
				const reader = response.body!.getReader()

				autoInstallDownloadSize = +response.headers.get("Content-Length")!

				let receivedLength = 0
				let chunks = []
				while (true) {
					const { done, value } = await reader.read()

					if (done) {
						break
					}

					chunks.push(value)
					receivedLength += value.length

					autoInstallDownloadProgress = receivedLength
				}

				chunksAll = new Uint8Array(receivedLength)
				let position = 0
				for (let chunk of chunks) {
					chunksAll.set(chunk, position)
					position += chunk.length
				}
			} catch (e) {
				window.alert("Couldn't download the mod! Check your internet connection, or contact the mod author for help.\n\n" + e)
				autoInstallDownloading = false
				return
			}

			window.fs.writeFileSync("./tempArchive", chunksAll)

			window.fs.emptyDirSync("./staging")
			window.child_process.execSync(`"..\\Third-Party\\7z.exe" x "./tempArchive" -aoa -y -o"./staging"`)

			autoInstallDownloading = false
			autoInstallModName = json5.parse(window.fs.readFileSync(window.path.join("./staging", window.fs.readdirSync("./staging")[0], "manifest.json"), "utf8")).name
			autoInstallModalOpen = true
		})()
	}

	function handleSort(event: any) {
		mergeConfig({
			loadOrder: event.detail.map((a: any) => a.value)
		})
		forceModListsUpdate = Math.random()
		changed = true
	}
</script>

{#if !cacheLoaded}
	<div class="flex flex-col items-center justify-center h-full w-full gap-4">
		<InlineLoading description="Loading mods cache..." />
	</div>
{:else}
<div class="grid grid-cols-2 gap-4 w-full mb-16">
	<div class="w-full">
		<div class="flex gap-4 items-center justify-center" transition:scale>
			<h1 class="flex-grow">Available Mods</h1>
			<div>
				<Search icon={Filter} placeholder="Filter available mods" bind:value={availableModFilter} />
			</div>
			<Button
				kind="primary"
				icon={Add}
				on:click={() => {
					openAddModDialog()
				}}
			>
				Add a Mod
			</Button>
		</div>
		<br />
		<div class="h-[90vh] overflow-y-auto">
			{#each disabledMods.filter((a) => ((modIsFramework(a.value) ? getManifestFromModID(a.value).name : a.value) + (modIsFramework(a.value) ? getManifestFromModID(a.value).description : ""))
					.toLowerCase()
					.includes(availableModFilter.toLowerCase())) as item (item.value)}
				<div animate:flip={{ duration: 300 }}>
					<div transition:scale>
						<Mod
							isFrameworkMod={modIsFramework(item.value)}
							manifest={modIsFramework(item.value) ? getManifestFromModID(item.value) : undefined}
							rpkgModName={!modIsFramework(item.value) ? item.value : undefined}
						>
							<Button
								kind="primary"
								icon={AddAlt}
								on:click={() => {
									mergeConfig({
										loadOrder: [...getConfig().loadOrder, item.value]
									})
									changed = true
									forceModListsUpdate = Math.random()
								}}
							>
								Enable
							</Button>
							<Button
								kind="danger"
								icon={TrashCan}
								on:click={() => {
									deleteModInProgress = item.value
									deleteModModalOpen = true
								}}
							>
								Delete
							</Button>
						</Mod>
					</div>
					<br />
				</div>
			{/each}
		</div>
	</div>
	<div class="w-full">
		<div class="flex gap-4 items-center justify-center" transition:scale>
			<h1 class="flex-grow">{changed && !deployFinished ? "To Be Applied" : "Enabled Mods"}</h1>
			<div>
				<Search icon={Filter} placeholder="Filter enabled mods" bind:value={enabledModFilter} />
			</div>
			<Button
				kind="primary"
				style={changed && !deployFinished ? "background-color: green" : ""}
				icon={Rocket}
				on:click={() => {
					if (sortMods()) {
						deployOutput = ""
						deployOutputHTML = ""
						deployFinished = false
						window.ipc.send("deploy")
					} else {
						dependencyCycleModalOpen = true
					}
				}}
			>
				Apply
			</Button>
		</div>
		<br />
		<div class="h-[90vh] overflow-y-auto">
			<SortableList
				list={enabledMods}
				key="value"
				on:sort={handleSort}
				let:item
			>
				<div class="cursor-grab">
					<Mod
						isFrameworkMod={modIsFramework(item.value)}
						manifest={modIsFramework(item.value) ? getManifestFromModID(item.value) : undefined}
						rpkgModName={!modIsFramework(item.value) ? item.value : undefined}
						darken={!((modIsFramework(item.value) ? getManifestFromModID(item.value).name : item.value) + (modIsFramework(item.value) ? getManifestFromModID(item.value).description : ""))
							.toLowerCase()
							.includes(enabledModFilter.toLowerCase())}
					>
						{#if modIsFramework(item.value) && getManifestFromModID(item.value)?.options?.filter((a) => a.type != OptionType.conditional)?.length}
							<Button
								kind="ghost"
								icon={Settings}
								iconDescription="Adjust this mod's settings"
								on:click={() => {
									goto(`/settings?mod=${getManifestFromModID(item.value).id}`)
								}}
							/>
						{/if}
						<Button
							kind="danger"
							icon={SubtractAlt}
							on:click={() => {
								mergeConfig({
									loadOrder: getConfig().loadOrder.filter((a) => a != item.value)
								})
								changed = true
								forceModListsUpdate = Math.random()
							}}
						>
							Disable
						</Button>
					</Mod>
					<br />
				</div>
			</SortableList>
		</div>
	</div>
</div>

{#if showDropHint}
	<div transition:fade={{ duration: 100 }} class="w-screen h-screen absolute top-0 left-0 bg-black/90 flex flex-col gap-4 justify-center items-center">
		<h1 class="font-bold">Drop to install</h1>
	</div>
{/if}

<Modal
	danger
	bind:open={deleteModModalOpen}
	modalHeading="Delete mod"
	primaryButtonText="Delete the mod"
	secondaryButtonText="Cancel"
	on:click:button--secondary={() => (deleteModModalOpen = false)}
	on:submit={() => {
		window.fs.removeSync(getModFolder(deleteModInProgress))
		mergeConfig({ knownMods: getConfig().knownMods.filter((a) => a != deleteModInProgress) })

		clearModsCache()
		clearValidationCache()
		forceModListsUpdate = Math.random()
		changed = true
		deleteModModalOpen = false
	}}
	shouldSubmitOnEnter={false}
>
	<p>
		{#if deleteModInProgress}
			Are you sure you want to permanently remove the <i>{modIsFramework(deleteModInProgress) ? getManifestFromModID(deleteModInProgress).name : deleteModInProgress}</i>
			mod from the Mods folder? You cannot undo this.
		{/if}
	</p>
</Modal>

<Modal alert bind:open={dependencyCycleModalOpen} modalHeading="Dependency cycle (couldn't sort mods)" primaryButtonText="OK" shouldSubmitOnEnter={false}>
	<p>The framework couldn't sort your mods! Ask the developer of whichever mod you most recently installed to investigate this. Also, report this to Atampy26 on Hitman Forum or Discord.</p>
</Modal>

<Modal passiveModal open={frameworkDeployModalOpen} modalHeading="Applying your mods" preventCloseOnClickOutside>
	Your mods are being deployed. This may take a while - grab a coffee or something.
	<br />
	<pre
		class="mt-2 h-[10vh] overflow-y-auto whitespace-pre-wrap bg-neutral-800 p-2"
		style="font-family: 'Fira Code', 'IBM Plex Mono', 'Menlo', 'DejaVu Sans Mono', 'Bitstream Vera Sans Mono', Courier, monospace; color-scheme: dark"
		id="deployOutputElement">{@html deployOutputHTML}</pre>
	{#if deployOutput.split(/\r?\n/).some((a) => a.match(/.*WARN.*?\t/)) || deployOutput.split(/\r?\n/).some((a) => a.match(/.*ERROR.*?\t/))}
		<br />
		<div class="flex flex-row gap-2 flex-wrap max-h-[15vh] overflow-y-auto">
			{#each deployDiagnostics as line}
				<InlineNotification hideCloseButton lowContrast kind={line.includes("WARN") ? "warning" : "error"}>
					<div slot="title" class="-mt-1 text-lg">
						{line.includes("WARN") ? "Warning" : "Error"}
					</div>
					<div slot="subtitle">{line.replace(/.*WARN.*?\t/, "").replace(/.*ERROR.*?\t/, "")}</div>
				</InlineNotification>
			{/each}
		</div>
	{/if}

	{#if deployFinished}
		<br />
		<div class="flex gap-4 items-center">
			{#if deployOutput
				.split(/\r?\n/)
				.map((a) => a.trim())
				.filter((a) => a.length)
				.at(-1)
				.match(/\tDone in .*/) && !deployOutput.split(/\r?\n/).some((a) => a.match(/.*WARN.*?\t/))}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<span class="text-green-300">Deploy successful</span>
			{:else if deployOutput
				.split(/\r?\n/)
				.map((a) => a.trim())
				.filter((a) => a.length)
				.at(-1)
				.match(/\tDone in .*/) && deployOutput.split(/\r?\n/).some((a) => a.match(/.*WARN.*?\t/))}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<span class="text-yellow-300">Potential issues in deployment</span>
			{:else}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<Button
					kind="primary"
					icon={CloudUpload}
					on:click={async () => {
						const req = await fetch("http://hitman-resources.netlify.app/.netlify/functions/upload-smf-log", {
							method: "POST",
							headers: {
								"Content-Type": "application/json"
							},
							body: JSON.stringify({ content: "Config:\n" + JSON.stringify(getConfig()) + "\n\nDeploy log:\n" + deployOutput })
						})

						if (req.status == 200) {
							uploadedLogURL = await req.text()

							frameworkDeployModalOpen = false
							uploadLogModalOpen = true
						} else {
							uploadLogFailedModalOpen = true
						}
					}}
				>
					Upload mod list and log
				</Button>
				<span class="text-red-300">Deploy unsuccessful</span>
			{/if}
		</div>
	{/if}
</Modal>

<Modal
	open={bulkImportModalOpen}
	modalHeading="Staged Mods for Import"
	primaryButtonText="Import Valid Mods"
	secondaryButtonText="Cancel"
	primaryButtonDisabled={stagedMods.filter(sm => sm.status !== "invalid").length === 0}
	on:click:button--primary={executeBulkImport}
	on:click:button--secondary={cancelBulkImport}
	on:close={cancelBulkImport}
>
	<div class="mt-4 max-h-[50vh] overflow-y-auto overflow-x-hidden pr-2">
		{#if stageInProgress}
			<div class="flex flex-col items-center justify-center py-8">
				<ProgressBar helperText="Analyzing and staging mods..." />
			</div>
		{:else}
			<div class="flex flex-col gap-4">
				{#each stagedMods as item (item.id)}
					<div class="flex flex-col gap-2 rounded bg-neutral-800 p-4 border border-neutral-700">
						<div class="flex items-center justify-between gap-4">
							<div class="flex flex-col min-w-0">
								<span class="font-bold text-white truncate text-[1rem]">{item.fileName}</span>
								<span class="text-xs text-neutral-400 truncate">{item.filePath}</span>
							</div>
							<div class="flex items-center gap-2 flex-shrink-0">
								{#if item.type === "framework"}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-blue-900 text-blue-200">Framework Mod</span>
								{:else if item.type === "rpkg"}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-purple-900 text-purple-200">RPKG Mod</span>
								{:else}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-neutral-700 text-neutral-300">Unknown</span>
								{/if}

								{#if item.status === "valid"}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-green-900 text-green-200">Ready</span>
								{:else if item.status === "warning"}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-yellow-900 text-yellow-200">Warning</span>
								{:else}
									<span class="px-2 py-0.5 rounded text-xs font-semibold bg-red-900 text-red-200">Invalid</span>
								{/if}

								<Button
									kind="ghost"
									size="small"
									icon={TrashCan}
									iconDescription="Remove"
									on:click={() => removeStagedMod(item.id)}
								/>
							</div>
						</div>

						{#if item.status === "invalid"}
							<div class="mt-2 text-xs text-red-400 bg-red-950/50 p-2 rounded border border-red-900/50">
								{#each item.errors as error}
									<div>• {error}</div>
								{/each}
							</div>
						{/if}

						{#if item.status === "warning"}
							<div class="mt-2 text-xs text-yellow-400 bg-yellow-950/50 p-2 rounded border border-yellow-900/50">
								{#each item.warnings as warning}
									<div>• {warning}</div>
								{/each}
							</div>
						{/if}

						{#if item.type === "rpkg" && item.status !== "invalid"}
							<div class="mt-2 flex flex-col gap-1">
								<label class="text-xs text-neutral-400" for="rpkgName-{item.id}">Mod folder name:</label>
								<input
									id="rpkgName-{item.id}"
									type="text"
									class="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 text-sm text-white focus:outline-none focus:border-blue-500 w-full"
									bind:value={item.rpkgNameInput}
								/>
							</div>
						{/if}

						{#if item.type === "framework" && item.status !== "invalid"}
							<div class="mt-2 text-xs text-neutral-400">
								Contains {item.mods.length} framework mod{item.mods.length > 1 ? 's' : ''}:
								<ul class="list-disc list-inside mt-1 ml-2 text-neutral-300">
									{#each item.mods as m}
										<li>{m.name} <span class="text-neutral-500">({m.id})</span></li>
									{/each}
								</ul>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</Modal>

<Modal
	alert
	bind:open={displayExtractedModsDialog}
	modalHeading="Incorrectly installed mod{extractedMods.length > 1 ? 's' : ''}"
	primaryButtonText="OK"
	shouldSubmitOnEnter={false}
	on:submit={() => (displayExtractedModsDialog = false)}
>
	<p>
		The mod{extractedMods.length > 1 ? "s" : ""}
		{extractedMods.slice(0, -1).length ? extractedMods.slice(0, -1).join(", ") + " and " + extractedMods[extractedMods.length - 1] : extractedMods[0]}
		{extractedMods.length > 1 ? "were" : "was"} installed by extracting the ZIP file directly to the Mods folder. That's not how you're meant to install mods; doing things this way could pose risks
		as it bypasses the framework's checks for mod validity and safety. Instead, use the Add a Mod button to add any mods you want. This message won't be shown again for {extractedMods.length > 1
			? "these mods"
			: "this mod"}.
		<br />
		<br />
		If you're seeing this after creating a new mod yourself, you should enable developer mode in the information page - it'll improve your experience and let you use the mod authoring tools in the
		Mod Manager.
	</p>
</Modal>

<Modal alert bind:open={uploadLogFailedModalOpen} modalHeading="Couldn't upload log" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (uploadLogFailedModalOpen = false)}>
	<p>Your log couldn't be uploaded. Make sure you're connected to the Internet.</p>
</Modal>

<Modal alert bind:open={uploadLogModalOpen} modalHeading="Log uploaded" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (uploadLogModalOpen = false)}>
	<p class="mb-2">Your deploy log has been anonymously uploaded to the Internet.</p>
	<CodeSnippet code={uploadedLogURL} />
	<br />
	<div class="mb-6" />
</Modal>

<Modal passiveModal open={autoInstallDownloading} modalHeading={"Downloading the mod"} preventCloseOnClickOutside>
	<div class="mb-2">The mod is currently being downloaded - please wait.</div>
	<br />
	<ProgressBar kind="inline" value={autoInstallDownloadProgress} max={autoInstallDownloadSize} labelText="Downloading..." />
</Modal>

<Modal
	bind:open={autoInstallModalOpen}
	modalHeading="Installing {autoInstallModName}"
	primaryButtonText="OK"
	secondaryButtonText="Cancel"
	shouldSubmitOnEnter={false}
	on:click:button--secondary={() => (autoInstallModalOpen = false)}
	on:click:button--primary={() => {
		autoInstallModalOpen = false
		stageFiles(["./tempArchive"])
	}}
>
	<p>The mod {autoInstallModName} has been downloaded via a link - would you like to install it?</p>
</Modal>
{/if}

<style>
	:global(.bx--btn--ghost) {
		color: inherit;
		@apply bg-neutral-800;
	}

	:global(.bx--btn--ghost:hover, .bx--btn--ghost:active) {
		color: inherit;
	}

	/* Remove the weird spacing; it's created by the border, which can't be seen due to the dark background */
	:global(li) {
		border: inherit !important;
		transition: inherit !important;
	}

	:global(.over) {
		border-color: inherit !important;
	}

	:global(.bx--modal-close) {
		display: none;
	}

	:global(.bx--inline-notification__icon) {
		display: none;
	}

	:global(.bx--snippet.bx--snippet--single) {
		background-color: #262626;
	}
</style>
