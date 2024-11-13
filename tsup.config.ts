import { writeFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['index.ts'],
	format: ['esm'],
	outDir: 'out',
	dts: true,
	clean: true,
	onSuccess: async function () {
		writeFileSync('./out/paths.json', JSON.stringify({ compilerOptions: { paths: {} } }))
	},
})
