<script lang="ts">
	import { Loading } from "carbon-components-svelte"

	export let showBuildingCache = false
	export let mt8 = false
</script>

<div class="flex flex-col items-center justify-center h-[80vh] w-full gap-4 {mt8 ? 'mt-8' : ''}">
	<Loading withOverlay={false} />
	<span class="text-gray-400 text-sm">
		{showBuildingCache ? "Building cache..." : "Loading mods cache..."}
	</span>
</div>
