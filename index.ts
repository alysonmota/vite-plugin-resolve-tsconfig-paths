import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import fg from 'fast-glob'
import type { PluginOption, ResolvedConfig } from 'vite'

type ResolvedAlias = {
	find: string
	replacement: string
}

type UnresolvedAlias = {
	baseUrl?: string
	paths: TsConfigPaths
}

type TsConfigPaths = Record<string, Array<string>>

type TsConfig = {
	compilerOptions: {
		paths?: Record<string, Array<string>>
		baseUrl?: string
	}
	extends?: Array<string>
}

function resolveTsConfigPath(tsConfigPath: string): TsConfig | undefined {
	const _tsconfigPath = resolve(tsConfigPath)
	const tsconfigExists = existsSync(resolve(_tsconfigPath))
	if (!tsconfigExists) return
	const tsConfigContent = JSON.parse(String(readFileSync(_tsconfigPath))) as TsConfig
	return {
		extends: tsConfigContent?.extends,
		compilerOptions: { baseUrl: tsConfigContent?.compilerOptions?.baseUrl, paths: tsConfigContent?.compilerOptions?.paths },
	}
}

function getRecursivePathsFromTsConfig(root: string, tsConfigPath: string): Array<UnresolvedAlias> {
	const tsConfigContent = resolveTsConfigPath(tsConfigPath)
	const aliases = new Array<UnresolvedAlias>(
		...(tsConfigContent?.compilerOptions?.paths && tsConfigContent?.compilerOptions?.baseUrl
			? [
					{
						baseUrl: tsConfigContent.compilerOptions.baseUrl,
						paths: tsConfigContent.compilerOptions.paths,
					} satisfies UnresolvedAlias,
				]
			: []),
	)

	if (Array.isArray(tsConfigContent?.extends)) {
		for (let extendsPath of tsConfigContent.extends) {
			if (!isAbsolute(extendsPath) && !extendsPath.startsWith('./')) {
				extendsPath = resolve(join(root, 'node_modules'), extendsPath.endsWith('.json') ? extendsPath : `${extendsPath}.json`)
			}
			const extendsTsConfigContent = resolveTsConfigPath(extendsPath)
			const baseUrlHasConfigDir = configDirRegex.test(String(extendsTsConfigContent?.compilerOptions?.baseUrl))
			if (!extendsTsConfigContent?.compilerOptions?.paths) continue
			let pathsHasConfigDir = false
			const paths = baseUrlHasConfigDir
				? extendsTsConfigContent?.compilerOptions?.paths
				: Object.fromEntries(
						Object.entries(extendsTsConfigContent?.compilerOptions?.paths || {}).filter(
							([_, values]) =>
								values.filter((v) => {
									if (configDirRegex.test(String(v))) {
										pathsHasConfigDir = true
										return true
									}
									return false
								}).length,
						),
					)

			if (!extendsTsConfigContent?.compilerOptions?.baseUrl && !pathsHasConfigDir) continue

			aliases.push({
				baseUrl: extendsTsConfigContent.compilerOptions.baseUrl,
				paths,
			} satisfies UnresolvedAlias)
		}
	}
	return aliases
}

const tsAliasSuffix = '/*'

function tryExtractFindPatternFromTsAlias(tsAlias: string): string | undefined {
	if (tsAlias.endsWith(tsAliasSuffix)) return tsAlias.slice(0, -tsAliasSuffix.length)
	return undefined
}

const configDirRegex = /\$\{configDir\}/g

function resolveAliases(root: string, aliases: Array<UnresolvedAlias>): Array<ResolvedAlias> {
	const resolvedAliases = new Array<ResolvedAlias>()

	for (const { baseUrl, paths } of aliases) {
		for (const [pattern, remaps] of Object.entries(paths)) {
			const [remapWithGreaterPriority] = remaps
			const remapWithGreaterPriorityWithoutAliasSuffix = tryExtractFindPatternFromTsAlias(remapWithGreaterPriority)
			if (!remapWithGreaterPriorityWithoutAliasSuffix) continue
			const findPattern = tryExtractFindPatternFromTsAlias(pattern)
			if (!findPattern) continue
			const _baseUrl = baseUrl === '.' ? root : baseUrl
			if (_baseUrl) {
				const baseUrlHasConfigDir = _baseUrl.includes('${configDir}')
				resolvedAliases.push({
					find: findPattern,
					replacement: baseUrlHasConfigDir
						? resolve(join(_baseUrl.replace(configDirRegex, root), remapWithGreaterPriorityWithoutAliasSuffix.replace(configDirRegex, String())))
						: resolve(join(_baseUrl.replace(configDirRegex, root), remapWithGreaterPriorityWithoutAliasSuffix.replace(configDirRegex, root))),
				})
				continue
			}

			resolvedAliases.push({
				find: findPattern,
				replacement: resolve(join(root, remapWithGreaterPriorityWithoutAliasSuffix.replace(configDirRegex, String()))),
			})
		}
	}

	return resolvedAliases
}

function resolveTsConfigAliases(): PluginOption {
	let resolvedAliases: Array<ResolvedAlias>

	return {
		name: '@vite-plugin/resolve-tsconfig-paths',
		enforce: 'pre',
		async resolveId(source) {
			for (const { find, replacement } of resolvedAliases) {
				if (new RegExp(find).test(source)) {
					const resolved = await this.resolve(source.replace(find, replacement))
					if (resolved) return resolved.id
				}
			}
		},
		async configResolved({ root }: ResolvedConfig) {
			const _root = root ?? cwd()
			const unresolvedAlias = new Array<UnresolvedAlias>()
			const tsConfigFiles = fg
				.sync(resolve(_root, '**/tsconfig(.*)?.json'), { onlyFiles: true, ignore: ['**/node_modules/**'] })
				.filter(function (tsConfigPath) {
					const tsConfigDir = dirname(tsConfigPath)
					const viteConfigFile = fg.sync(resolve(dirname(tsConfigDir), 'vite.config.{js,ts}'), { onlyFiles: true })
					if (viteConfigFile.length && tsConfigDir !== _root) return false
					return true
				})
			for (const tsConfig of tsConfigFiles) {
				const tsConfigPaths = getRecursivePathsFromTsConfig(_root, tsConfig)
				if (tsConfigPaths.length) unresolvedAlias.push(...tsConfigPaths)
			}
			resolvedAliases = resolveAliases(_root, unresolvedAlias)
		},
	}
}

export { getRecursivePathsFromTsConfig, resolveAliases, resolveTsConfigAliases }
