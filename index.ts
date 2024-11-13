import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import fg from 'fast-glob'
import type { AliasOptions, PluginOption, ResolvedConfig, UserConfig } from 'vite'

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

const configDirRegex = /\$\{configDir\}/g

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

function removeSuffixPatternFromTsAlias(tsAlias: string) {
	if (tsAlias.endsWith(tsAliasSuffix)) return tsAlias.slice(0, -tsAliasSuffix.length)
	return tsAlias
}

function resolveMaps(baseUrl: string, maps: Array<string>) {
	for (let m = 0; m < maps.length; m++) {
		const mapWithoutSuffixPattern = removeSuffixPatternFromTsAlias(maps[m])
		maps[m] = mapWithoutSuffixPattern === '*' ? resolve(baseUrl) : resolve(baseUrl, mapWithoutSuffixPattern.replace(configDirRegex, String()))
	}

	return maps
}

function resolveAliases(root: string, aliases: Array<UnresolvedAlias>): Array<ResolvedAlias> {
	const resolvedAliases = new Array<ResolvedAlias>()

	for (const { baseUrl, paths } of aliases) {
		for (const [pattern, remaps] of Object.entries(paths)) {
			const patternWithoutSuffix = removeSuffixPatternFromTsAlias(pattern)
			if (!patternWithoutSuffix) continue

			const _baseUrl = (baseUrl === '.' ? root : baseUrl?.startsWith('${configDir}') ? baseUrl.replace(configDirRegex, root) : baseUrl) ?? root
			const [map] = resolveMaps(_baseUrl, remaps).filter(existsSync) ?? []
			if (!map) continue
			resolvedAliases.push({
				find: patternWithoutSuffix,
				replacement: map,
			})
		}
	}

	return resolvedAliases
}

type ResolveTsConfigPathsOptions = {
	generatePathsFromViteConfig?: boolean
}

function resolveTsConfigPaths({ generatePathsFromViteConfig = false }: ResolveTsConfigPathsOptions): PluginOption {
	let resolvedAliases: Array<ResolvedAlias>
	let aliasFromViteConfig: AliasOptions | undefined
	const paths = <TsConfigPaths>new Object()

	return {
		name: 'vite-plugin-resolve-tsconfig-paths',
		enforce: 'pre',
		async resolveId(source) {
			for (const { find, replacement } of resolvedAliases) {
				if (new RegExp(find).test(source)) {
					const resolved = await this.resolve(source.replace(find, replacement))
					if (resolved) return resolved.id
				}
			}
		},
		config(config: UserConfig) {
			const { resolve } = config
			if (generatePathsFromViteConfig && resolve?.alias) aliasFromViteConfig = resolve?.alias
		},
		async configResolved({ root = cwd() }: ResolvedConfig) {
			if (generatePathsFromViteConfig) {
				if (Array.isArray(aliasFromViteConfig)) {
					for (const map of aliasFromViteConfig) {
						const { find, replacement } = map
						if (find instanceof RegExp) continue
						const alias = replacement.startsWith('./') ? resolve(root, replacement) : resolve(replacement)
						const aliasIsFile = /^.*\.*$/g.test(alias)
						paths[aliasIsFile ? find : find.concat('/*')] = [aliasIsFile ? alias : alias.endsWith('/') ? alias.concat('*') : alias.concat('/*')]
					}
					writeFileSync('./paths.json', JSON.stringify({ compilerOptions: { baseUrl: root, paths } }))
				}
			}

			const unresolvedAlias = new Array<UnresolvedAlias>()
			const tsConfigFiles = fg.sync(resolve(root, '/tsconfig(.*)?.json'), { onlyFiles: true }).filter(function (tsConfigPath) {
				const tsConfigDir = dirname(tsConfigPath)
				const viteConfigFile = fg.sync(resolve(dirname(tsConfigDir), 'vite.config.{js,ts}'), { onlyFiles: true })
				if (viteConfigFile.length && tsConfigDir !== root) return false
				return true
			})
			for (const tsConfig of tsConfigFiles) {
				const tsConfigPaths = getRecursivePathsFromTsConfig(root, tsConfig)
				if (tsConfigPaths.length) unresolvedAlias.push(...tsConfigPaths)
			}
			resolvedAliases = resolveAliases(root, unresolvedAlias)
		},
	}
}

export { resolveTsConfigPaths }
