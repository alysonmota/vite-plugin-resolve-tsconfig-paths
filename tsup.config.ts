import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['index.ts'],
	format: ['esm'],
	outDir: 'out',
	dts: true,
	clean: true,
})
