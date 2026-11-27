import 'zone.js'
import 'core-js/proposals/reflect-metadata'
import 'rxjs'

import './global.scss'
import './toastr.scss'

// Importing before @angular/*
import { findPlugins, initModuleLookup, loadPlugins } from './plugins'

import { enableProdMode, NgModuleRef, ApplicationRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
import { ipcRenderer } from 'electron'

import { getRootModule } from './app.module'
import { BootstrapData, BOOTSTRAP_DATA, PluginInfo } from '../../tabby-core/src/api/mainProcess'

// Always land on the start view
location.hash = ''

;(process as any).enablePromiseAPI = true

if (process.platform === 'win32' && !('HOME' in process.env)) {
    process.env.HOME = `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
}

if (process.env.TABBY_DEV && !process.env.TABBY_FORCE_ANGULAR_PROD) {
    console.warn('Running in debug mode')
} else {
    enableProdMode()
}

// SmartSSH portable state, mirrored into the renderer for UI/diagnostics.
// The authoritative redirect — app.setPath('userData', <resolved path>) — is done once in the main
// process by app/lib/portable.ts (imported from app/lib/index.ts before app.whenReady(); see
// smartssh/app/portablePath.mjs for the resolution rules). A renderer must not touch app paths, so
// this side only reads what the main process published and hands it to the page.
const smartsshPortable = {
    portableRoot: process.env.PORTABLE_EXECUTABLE_DIR ?? null,
    userDataPath: process.env.SMARTSSH_USERDATA_PATH ?? null,
    readOnly: process.env.SMARTSSH_PORTABLE_READONLY === '1',
}
window['smartsshPortable'] = smartsshPortable
if (smartsshPortable.readOnly) {
    console.warn('SmartSSH: read-only portable media, userData is scratch space:', smartsshPortable.userDataPath)
}

async function bootstrap (bootstrapData: BootstrapData, plugins: PluginInfo[], safeMode = false): Promise<NgModuleRef<any>> {
    if (safeMode) {
        plugins = plugins.filter(x => x.isBuiltin)
    }

    const pluginModules = await loadPlugins(plugins, (current, total) => {
        (document.querySelector('.progress .bar') as HTMLElement).style.width = `${100 * current / total}%` // eslint-disable-line
    })

    window['pluginModules'] = pluginModules

    const module = getRootModule(pluginModules)
    const moduleRef = await platformBrowserDynamic([
        { provide: BOOTSTRAP_DATA, useValue: bootstrapData },
    ]).bootstrapModule(module)
    if (process.env.TABBY_DEV) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const componentRef = applicationRef.components[0]
        enableDebugTools(componentRef)
    }
    return moduleRef
}

ipcRenderer.once('start', async (_$event, bootstrapData: BootstrapData) => {
    console.log('Window bootstrap data:', bootstrapData)

    initModuleLookup(bootstrapData.userPluginsPath)

    let plugins = await findPlugins()
    bootstrapData.installedPlugins = plugins
    if (bootstrapData.config.pluginBlacklist) {
        plugins = plugins.filter(x => !bootstrapData.config.pluginBlacklist.includes(x.name))
    }
    plugins = plugins.filter(x => x.name !== 'web')

    console.log('Starting with plugins:', plugins)
    try {
        await bootstrap(bootstrapData, plugins)
    } catch (error) {
        console.error('Angular bootstrapping error:', error)
        console.warn('Trying safe mode')
        window['safeModeReason'] = error
        try {
            await bootstrap(bootstrapData, plugins, true)
        } catch (error2) {
            console.error('Bootstrap failed:', error2)
        }
    }
})

ipcRenderer.send('ready')
