<script lang="ts">
	import { FrameworkVersion, getConfig, mergeConfig } from "$lib/utils"

	import { Button, Checkbox } from "carbon-components-svelte"

	import { fade } from "svelte/transition"
	import { v4 } from "uuid"

	let forceUpdate = Math.random()
	let clickCount = 0
	let displayVersion = FrameworkVersion

	let devModeClicks = 0
	let lastDevModeClick = 0
	let showDevGod = false
	let devGodTimeout: any = null

	let skipIntroClicks = 0
	let lastSkipIntroClick = 0
	let showSpeedrunner = false
	let speedrunnerTimeout: any = null

	let errorReportingClicks = 0
	let lastErrorReportingClick = 0
	let showErrorReportingGod = false
	let errorReportingTimeout: any = null

	function handleDevModeClick() {
		const now = Date.now()
		if (now - lastDevModeClick < 1000) {
			devModeClicks++
		} else {
			devModeClicks = 1
		}
		lastDevModeClick = now

		if (devModeClicks >= 5) {
			showDevGod = true
			if (devGodTimeout) clearTimeout(devGodTimeout)
			devGodTimeout = setTimeout(() => {
				showDevGod = false
			}, 3000)
		}
	}

	function handleSkipIntroCheck() {
		const now = Date.now()
		if (now - lastSkipIntroClick < 1000) {
			skipIntroClicks++
		} else {
			skipIntroClicks = 1
		}
		lastSkipIntroClick = now

		if (skipIntroClicks >= 5) {
			showSpeedrunner = true
			if (speedrunnerTimeout) clearTimeout(speedrunnerTimeout)
			speedrunnerTimeout = setTimeout(() => {
				showSpeedrunner = false
			}, 3000)
		}
	}

	function handleErrorReportingClick() {
		const now = Date.now()
		if (now - lastErrorReportingClick < 1000) {
			errorReportingClicks++
		} else {
			errorReportingClicks = 1
		}
		lastErrorReportingClick = now

		if (errorReportingClicks >= 5) {
			showErrorReportingGod = true
			if (errorReportingTimeout) clearTimeout(errorReportingTimeout)
			errorReportingTimeout = setTimeout(() => {
				showErrorReportingGod = false
			}, 3000)
		}
	}
</script>

<div class="w-full h-full flex items-center justify-center">
	<div>
		<h1 in:fade>Information</h1>
		<p in:fade={{ delay: 400 }}>
			This GUI is powered by Svelte, and the CLI is powered by Node.js. You're on framework version
			<button
				class="cursor-pointer select-none font-bold text-blue-400 hover:text-blue-300 transition-colors bg-transparent border-0 p-0 text-base"
				on:click={() => {
					clickCount++
					if (clickCount >= 5) {
						displayVersion = `${FrameworkVersion} 🚀 Fully Charged 🔥`
					}
				}}
			>
				{displayVersion}
			</button>
			.
		</p>
		<br />
		<p in:fade={{ delay: 800 }}>Thanks to the Hitman modding community for making this possible, and thanks to IO Interactive for making the game this is for.</p>
		<br />
		<div in:fade={{ delay: 1200 }} class="inline-flex items-center gap-2">
			<Checkbox
				checked={getConfig().skipIntro}
				on:check={({ detail }) => {
					handleSkipIntroCheck()
					mergeConfig({ skipIntro: detail })
				}}
				labelText="Skip intro"
			/>
			{#if showSpeedrunner}
				<span transition:fade class="text-green-400 font-bold ml-2">Speedrunner 🏃💨</span>
			{/if}
		</div>
		<br />
		<br />
		<div in:fade={{ delay: 1600 }}>
			<div class="flex gap-4 items-center">
				<Button
					kind="primary"
					on:click={() => {
						handleDevModeClick()
						if (getConfig().developerMode) {
							mergeConfig({
								developerMode: false,
								knownMods: []
							})

							forceUpdate = Math.random()
						} else {
							mergeConfig({
								developerMode: true,
								knownMods: []
							})

							forceUpdate = Math.random()
						}
					}}
				>
					{forceUpdate && getConfig().developerMode ? "Disable" : "Enable"} developer mode
				</Button>
				{#if showDevGod}
					<span transition:fade class="text-yellow-400 font-bold ml-4">THE DEV OF GOD 😇👼</span>
				{/if}
			</div>
		</div>
		<br />
		<div in:fade={{ delay: 2000 }}>
			<div class="flex gap-4 items-center">
				<Button
					kind="primary"
					on:click={() => {
						handleErrorReportingClick()
						if (getConfig().reportErrors) {
							mergeConfig({
								reportErrors: false,
								errorReportingID: undefined
							})

							forceUpdate = Math.random()
						} else {
							mergeConfig({
								reportErrors: true,
								errorReportingID: v4()
							})

							forceUpdate = Math.random()
						}
					}}
				>
					{forceUpdate && getConfig().reportErrors ? "Disable" : "Enable"} error reporting
				</Button>
				{#if showErrorReportingGod}
					<span transition:fade class="text-red-400 font-bold ml-4">I'm a **** person, cause I always want to report error! 😎</span>
				{/if}
				{#if forceUpdate && getConfig().reportErrors && !showErrorReportingGod}
					<span class="text-gray-300">Your reporting ID is {forceUpdate && getConfig().errorReportingID}</span>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
</style>
