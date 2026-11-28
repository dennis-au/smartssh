import { Observable, Subject, first, auditTime, debounce, interval } from 'rxjs'
import { Spinner } from 'cli-spinner'
import colors from 'ansi-colors'
import { NgZone, OnInit, OnDestroy, Injector, ViewChild, HostBinding, Input, ElementRef, InjectFlags, Component } from '@angular/core'
import { trigger, transition, style, animate, AnimationTriggerMetadata } from '@angular/animations'
import { AppService, ConfigService, BaseTabComponent, HostAppService, HotkeysService, NotificationsService, Platform, LogService, Logger, TabContextMenuItemProvider, SplitTabComponent, SubscriptionContainer, MenuItemOptions, PlatformService, HostWindowService, ResettableTimeout, TranslateService, ThemesService, FullyDefined } from 'tabby-core'

import { BaseSession } from '../session'

import { Frontend } from '../frontends/frontend'
import { XTermFrontend, XTermWebGLFrontend } from '../frontends/xtermFrontend'
import { shouldUseWebGL } from '../frontends/webglSupport'
import { ResizeEvent, BaseTerminalProfile } from './interfaces'
import { TerminalDecorator } from './decorator'
import { SearchPanelComponent } from '../components/searchPanel.component'
import { MultifocusService } from '../services/multifocus.service'
import { getTerminalBackgroundColor } from '../helpers'
import { createProposalService } from '../../../smartssh/app/proposalService.mjs'
import { isMeasureEnabled } from '../../../smartssh/app/metricsPath.mjs'
import { createRelayBridgeFromEnv } from '../../../smartssh/app/relayBridge.mjs'


const INACTIVE_TAB_UNLOAD_DELAY = 1000 * 30
const OSC_FOCUS_IN = Buffer.from('\x1b[I')
const OSC_FOCUS_OUT = Buffer.from('\x1b[O')

/**
 * A class to base your custom terminal tabs on
 */
@Component({ template: '' })
export class BaseTerminalTabComponent<P extends BaseTerminalProfile> extends BaseTabComponent implements OnInit, OnDestroy {
    static template: string = require('../components/baseTerminalTab.component.pug')
    static styles: string[] = [require('../components/baseTerminalTab.component.scss')]
    static animations: AnimationTriggerMetadata[] = [
        trigger('toolbarSlide', [
            transition(':enter', [
                style({
                    transform: 'translateY(-25%)',
                    opacity: '0',
                }),
                animate('100ms ease-out', style({
                    transform: 'translateY(0%)',
                    opacity: '1',
                })),
            ]),
            transition(':leave', [
                animate('100ms ease-out', style({
                    transform: 'translateY(-25%)',
                    opacity: '0',
                })),
            ]),
        ]),
        trigger('panelSlide', [
            transition(':enter', [
                style({
                    transform: 'translateY(25%)',
                    opacity: '0',
                }),
                animate('100ms ease-out', style({
                    transform: 'translateY(0%)',
                    opacity: '1',
                })),
            ]),
            transition(':leave', [
                animate('100ms ease-out', style({
                    transform: 'translateY(25%)',
                    opacity: '0',
                })),
            ]),
        ]),
    ]

    session: BaseSession|null = null
    savedState?: any
    savedStateIsLive = false

    @Input() zoom = 0

    /** SmartSSH approval bar. null means "no proposal", so the row is not rendered at all. */
    smartsshProposal: any = null

    /**
     * Latest prompt token learned by a SmartSSH push, and whether the relay proved it with two
     * agreeing samples. Empty/untrusted keeps the gate fail-closed: no token, no proposal.
     */
    smartsshProposalToken = ''
    smartsshProposalTokenTrusted = false

    /** The only writer of `smartsshProposal`; see startSmartSSHProposal(). */
    private smartsshProposalService: any = null
    private smartsshProposalUnsubscribe: (() => void)|null = null
    /**
     * Relay side of the same feature: model events -> relay v2 HTTP calls. Null when the relay is
     * not configured or failed to start; the bar then shows `offline` and the app still works.
     */
    private smartsshRelayBridge: any = null
    private smartsshRelayContext = { proposalId: '', tabId: '', sessionId: '' }
    private smartsshRelayConfirmCode = ''
    private smartsshRelayLocalId =
        (globalThis as any).crypto?.randomUUID?.() ?? `smartssh-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

    @Input() showSearchPanel = false

    /** @hidden */
    @ViewChild('content') content

    /** @hidden */
    @HostBinding('style.background-color') backgroundColor: string|null = null

    /** @hidden */
    @HostBinding('class.toolbar-enabled') enableToolbar = false

    /** @hidden */
    @HostBinding('class.toolbar-pinned') pinToolbar = false

    /** @hidden */
    @HostBinding('class.toolbar-revealed') revealToolbar = false

    frontend?: Frontend

    /** @hidden */
    frontendIsReady = false

    frontendReady = new Subject<void>()
    size: ResizeEvent

    profile: FullyDefined<P>

    /**
     * Enables normal passthrough from session output to terminal input
     */
    enablePassthrough = true

    /**
     * Disables display of dynamic window/tab title provided by the shell
     */
    disableDynamicTitle = false

    alternateScreenActive = false

    @ViewChild(SearchPanelComponent, { 'static': false }) searchPanel?: SearchPanelComponent

    // Deps start
    config: ConfigService
    element: ElementRef
    protected zone: NgZone
    protected app: AppService
    protected hostApp: HostAppService
    protected hotkeys: HotkeysService
    protected platform: PlatformService
    protected notifications: NotificationsService
    protected log: LogService
    protected decorators: TerminalDecorator[] = []
    protected contextMenuProviders: TabContextMenuItemProvider[]
    protected hostWindow: HostWindowService
    protected translate: TranslateService
    protected multifocus: MultifocusService
    protected themes: ThemesService
    // Deps end

    protected logger: Logger
    protected output = new Subject<string>()
    protected binaryOutput = new Subject<Buffer>()
    protected sessionChanged = new Subject<BaseSession|null>()
    protected recentInputs = ''
    private bellPlayer: HTMLAudioElement
    private termContainerSubscriptions = new SubscriptionContainer()
    private sessionHandlers = new SubscriptionContainer()
    private spinner = new Spinner({
        stream: {
            write: x => {
                try {
                    if (!this.frontend) {
                        return
                    }
                    this.writeRaw(x)
                } catch {
                    this.spinner.stop()
                }
            },
        },
    })

    private spinnerActive = false
    private spinnerPaused = false
    private toolbarRevealTimeout = new ResettableTimeout(() => {
        this.revealToolbar = false
    }, 1000)

    private frontendWriteLock = Promise.resolve()

    get input$ (): Observable<Buffer> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.input$
    }

    get output$ (): Observable<string> { return this.output }
    get binaryOutput$ (): Observable<Buffer> { return this.binaryOutput }

    get resize$ (): Observable<ResizeEvent> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Observable<boolean> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.alternateScreenActive$
    }

    get frontendReady$ (): Observable<void> { return this.frontendReady }

    get sessionChanged$ (): Observable<BaseSession|null> { return this.sessionChanged }

    constructor (protected injector: Injector) {
        super(injector)

        this.config = injector.get(ConfigService)
        this.element = injector.get(ElementRef)
        this.zone = injector.get(NgZone)
        this.app = injector.get(AppService)
        this.hostApp = injector.get(HostAppService)
        this.hotkeys = injector.get(HotkeysService)
        this.platform = injector.get(PlatformService)
        this.notifications = injector.get(NotificationsService)
        this.log = injector.get(LogService)
        this.decorators = injector.get<any>(TerminalDecorator, null, InjectFlags.Optional) as TerminalDecorator[]
        this.contextMenuProviders = injector.get<any>(TabContextMenuItemProvider, null, InjectFlags.Optional) as TabContextMenuItemProvider[]
        this.hostWindow = injector.get(HostWindowService)
        this.translate = injector.get(TranslateService)
        this.multifocus = injector.get(MultifocusService)
        this.themes = injector.get(ThemesService)

        this.logger = this.log.create('baseTerminalTab')
        this.setTitle(this.translate.instant('Terminal'))

        this.subscribeUntilDestroyed(this.hotkeys.unfilteredHotkey$, async hotkey => {
            if (!this.hasFocus) {
                return
            }
            if (hotkey === 'search') {
                this.showSearchPanel = true
                setImmediate(() => {
                    const input = this.element.nativeElement.querySelector('.search-input')
                    const selectedText = (this.frontend?.getSelection() ?? '').trim()
                    if (input && selectedText.length) {
                        input.value = selectedText
                    }

                    input?.focus()
                    input?.select()
                })
            }
        })

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, async hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'ctrl-c':
                    if (this.frontend?.getSelection()) {
                        this.frontend.copySelection()
                        this.frontend.clearSelection()
                        this.notifications.notice(this.translate.instant('Copied'))
                    } else {
                        this.forEachFocusedTerminalPane(tab => tab.sendInput('\x03'))
                    }
                    break
                case 'copy':
                    this.frontend?.copySelection()
                    this.frontend?.clearSelection()
                    this.notifications.notice(this.translate.instant('Copied'))
                    break
                case 'paste':
                    this.forEachFocusedTerminalPane(tab => tab.paste())
                    break
                case 'select-all':
                    this.frontend?.selectAll()
                    break
                case 'switch-meta-option': {
                    const altIsMeta = !this.config.store.terminal.altIsMeta
                    this.config.store.terminal.altIsMeta = altIsMeta
                    this.config.save()
                    // no config.changed$ listener here - re-apply to this tab now, others on focus
                    this.configure()
                    this.notifications.notice(this.translate.instant(
                        altIsMeta ? 'Option key now sends Meta' : 'Option key now sends its normal character',
                    ))
                    break
                }
                case 'clear':
                    this.forEachFocusedTerminalPane(tab => {
                        const tabProfile = tab.profile
                        const shellType: string = tabProfile.options?.shellType ?? ''
                        const shellArgs: string[] = tabProfile.options?.args ?? []
                        if (this.hostApp.platform === Platform.Windows && (shellType === 'powershell' || shellArgs.some(arg => arg.includes('clink')))) {
                            // Windows PowerShell and cmd(Clink): send Ctrl+L to PTY (natively clears)
                            tab.sendInput('\x0c')
                        } else {
                            // Windows cmd(stock) and macOS/Linux: clear xterm buffer only
                            tab.frontend?.clear()
                        }
                    })
                    break
                case 'zoom-in':
                    this.forEachFocusedTerminalPane(tab => tab.zoomIn())
                    break
                case 'zoom-out':
                    this.forEachFocusedTerminalPane(tab => tab.zoomOut())
                    break
                case 'reset-zoom':
                    this.forEachFocusedTerminalPane(tab => tab.resetZoom())
                    break
                case 'previous-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1b[1;5D',
                            [Platform.macOS]: '\x1bb',
                            [Platform.Linux]: '\x1bb',
                        }[this.hostApp.platform])
                    })
                    break
                case 'next-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1b[1;5C',
                            [Platform.macOS]: '\x1bf',
                            [Platform.Linux]: '\x1bf',
                        }[this.hostApp.platform])
                    })
                    break
                case 'delete-line':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput('\x1bw')
                    })
                    break
                case 'delete-previous-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput('\u0017')
                    })
                    break
                case 'delete-next-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1bd\x1b[3;5~',
                            [Platform.macOS]: '\x1bd',
                            [Platform.Linux]: '\x1bd',
                        }[this.hostApp.platform])
                    })
                    break
                case 'insert-new-line':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput('\x1b\r')
                    })
                    break
                case 'copy-current-path':
                    this.copyCurrentPath()
                    break
                case 'scroll-to-top':
                    this.frontend?.scrollToTop()
                    break
                case 'scroll-page-up':
                    this.frontend?.scrollPages(-1)
                    break
                case 'scroll-up':
                    this.frontend?.scrollLines(-1)
                    break
                case 'scroll-down':
                    this.frontend?.scrollLines(1)
                    break
                case 'scroll-page-down':
                    this.frontend?.scrollPages(1)
                    break
                case 'scroll-to-bottom':
                    this.frontend?.scrollToBottom()
                    break
            }
        })

        this.bellPlayer = document.createElement('audio')
        this.bellPlayer.src = require('../bell.ogg')
        this.bellPlayer.load()

        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    /** @hidden */
    ngOnInit (): void {
        this.pinToolbar = this.enableToolbar && (window.localStorage.pinTerminalToolbar ?? 'true') === 'true'

        this.focused$.subscribe(() => {
            this.configure()
            this.frontend?.focus()
        })

        this.subscribeUntilDestroyed(this.platform.themeChanged$, () => {
            this.configure()
        })

        const cls: new (..._) => Frontend = shouldUseWebGL(
            this.config.store.terminal.frontend,
            this.config.store.hacks.disableGPU,
        ) ? XTermWebGLFrontend : XTermFrontend
        this.frontend = new cls(this.injector)

        this.frontendReady$.pipe(first()).subscribe(() => {
            this.onFrontendReady()
        })

        this.frontend.resize$.pipe(first()).subscribe(async ({ columns, rows }) => {
            this.size = { columns, rows }
            this.frontendReady.next()
            this.frontendReady.complete()

            this.config.enabledServices(this.decorators).forEach(decorator => {
                try {
                    decorator.attach(this)
                } catch (e) {
                    this.logger.warn('Decorator attach() throws', e)
                }
            })

            setTimeout(() => {
                // Send the *current* size, not the one captured when the frontend
                // first reported: if the layout settles to a different size while
                // the session is still connecting, the captured value would arrive
                // last and revert the pty to a stale geometry, permanently
                // desyncing the shell's idea of the terminal size (#11759).
                if (this.session) {
                    this.session.resize(this.size.columns, this.size.rows)
                }
            }, 1000)

            this.session?.releaseInitialDataBuffer()
            this.sessionChanged$.subscribe(() => {
                this.session?.releaseInitialDataBuffer()
            })
        })

        this.alternateScreenActive$.subscribe(x => {
            this.alternateScreenActive = x
        })

        setImmediate(async () => {
            if (this.hasFocus) {
                await this.frontend?.attach(this.content.nativeElement, this.profile)
                this.frontend?.configure(this.profile)
            } else {
                this.focused$.pipe(first()).subscribe(async () => {
                    await this.frontend?.attach(this.content.nativeElement, this.profile)
                    this.frontend?.configure(this.profile)
                })
            }
        })

        this.attachTermContainerHandlers()

        this.configure()

        setTimeout(() => {
            this.binaryOutput$.subscribe(() => {
                this.displayActivity()
            })
        }, 1000)

        this.frontend.bell$.subscribe(() => {
            if (this.config.store.terminal.bell === 'visual') {
                this.frontend?.visualBell()
            }
            if (this.config.store.terminal.bell === 'audible') {
                this.bellPlayer.play()
            }
            if (this.config.store.terminal.bellFlashFrame) {
                this.hostWindow.flashFrame()
            }
            if (!this.hasFocus) {
                this.displayActivity()
            }
        })

        this.frontend.focus()

        this.blurred$.subscribe(() => {
            this.multifocus.cancel()
        })

        this.visibility$
            .pipe(debounce(visibility => interval(visibility ? 0 : INACTIVE_TAB_UNLOAD_DELAY)))
            .subscribe(visibility => {
                if (visibility && this.frontend instanceof XTermFrontend) {
                    this.frontend.reactivate()
                }
            })
    }

    protected onFrontendReady (): void {
        this.frontendIsReady = true
        if (this.savedState) {
            this.frontend!.restoreState(this.savedState)
            if (!this.savedStateIsLive) {
                this.frontend!.write('\r\n\r\n')
                this.frontend!.write(colors.bgWhite.black(' * ') + colors.bgBlackBright.white(' History restored '))
                this.frontend!.write('\r\n\r\n')
            }
        }

        this.input$.subscribe(data => {
            this.recentInputs += data
            this.recentInputs = this.recentInputs.substring(this.recentInputs.length - 32)
        })

        this.startSmartSSHProposal()
    }

    /**
     * SmartSSH: attach the proposal producer to this tab's xterm buffer.
     *
     * Before this, `smartsshProposal` was declared and never assigned, so `smartssh-bar` in
     * baseTerminalTab.component.pug could never render and the whole feature was dead in the
     * shipped exe. The service is now the single writer of that field: it reads the real buffer,
     * runs the gate and the settler from smartssh/core, and publishes a model that has already
     * passed `barModel()`. A null model unmounts the bar (no `*ngIf` change needed).
     */
    protected startSmartSSHProposal (): void {
        if (this.smartsshProposalService) {
            return
        }
        const xterm = (this.frontend as any)?.xterm
        if (!xterm) {
            return
        }
        try {
            // One switch name (SMARTSSH_MEASURE) and a path rooted at the exe directory — the same
            // rules `windows-checklist.ps1` reads. A renderer may have no `process` at all.
            const env: Record<string, string|undefined> = (globalThis as any).process?.env ?? {}
            this.smartsshProposalService = createProposalService({
                buffer: () => this.smartSSHBuffer(),
                token: { token: this.smartsshProposalToken, tokenTrusted: this.smartsshProposalTokenTrusted },
                clock: { now: () => Date.now() },
                intervalMs: 120,
                autoRun: 'off', // the renderer may never arm auto-run on its own
                // Path is resolved by the service at flush time (SMARTSSH_MEASURE_PATH, else
                // <exe dir>/data/metrics.json), so a renderer without process.execPath still runs.
                metrics: isMeasureEnabled(env),
                measurement: (caseId: string) => this.measureSmartSSHCase(caseId),
            })
        } catch (error) {
            this.logger.warn('SmartSSH proposal service failed to start', error)
            this.smartsshProposalService = null
            return
        }
        this.smartsshProposalUnsubscribe = this.smartsshProposalService.subscribe((model: any) => {
            this.zone.run(() => {
                this.smartsshProposal = model
            })
        })
        // Relay transport for the same model events. A missing SMARTSSH_RELAY_URL/RELAY_TOKEN, or
        // any construction failure, leaves the bridge null/offline: the terminal keeps working.
        try {
            this.smartsshRelayBridge = createRelayBridgeFromEnv({
                service: this.smartsshProposalService,
                env: (globalThis as any).process?.env ?? {},
                proposalId: () => this.smartsshRelayContext.proposalId,
                tabId: () => this.smartsshRelayContext.tabId || this.smartsshRelayLocalId,
                sessionId: () => this.smartsshRelayContext.sessionId || this.smartsshRelayLocalId,
                confirmCode: () => this.smartsshRelayConfirmCode,
            })
            this.smartsshRelayBridge.start()
        } catch (error) {
            this.logger.warn('SmartSSH relay bridge failed to start', error)
            this.smartsshRelayBridge = null
        }
        this.smartsshProposalService.start()
    }

    /** The injectable buffer reader: a live view over this tab's xterm buffer. */
    private smartSSHBuffer (): any {
        const xterm = (this.frontend as any)?.xterm
        if (!xterm) {
            return null
        }
        const active = () => xterm.buffer.active
        const tab = this
        return {
            get cols () { return xterm.cols },
            get rows () { return xterm.rows },
            get cursorX () { return active().cursorX },
            get cursorY () { return active().cursorY },
            get baseY () { return active().baseY },
            get viewportY () { return active().viewportY },
            get altScreen () { return active().type === 'alternate' },
            get selection () { return !!tab.frontend?.getSelection?.() },
            getLine: (y: number) => active().getLine(y),
        }
    }

    /** Read the terminal's current viewport for SMARTSSH_MEASURE=1. */
    private measureSmartSSHCase (_caseId: string): any {
        const xterm = (this.frontend as any)?.xterm
        const el: HTMLElement|undefined = this.content?.nativeElement
        if (!xterm || !el || typeof window === 'undefined') {
            return {}
        }
        const rect = el.getBoundingClientRect()
        const { devicePixelRatio } = window
        if (!(rect.height > 0) || !(xterm.rows > 0) || !(xterm.cols > 0) ||
            !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
            return {}
        }
        // `caseId` is only a label here: buildMeasurement() decides whether this real viewport IS
        // that case, and falls back to a declared CASE_SPEC value (with a note) when it is not.
        return {
            measuredViewport: {
                wCss: window.innerWidth,
                hCss: window.innerHeight,
                devicePixelRatio,
                rows: xterm.rows,
                cols: xterm.cols,
                cellHeightPx: rect.height / xterm.rows,
                heightPx: rect.height,
            },
        }
    }

    /** Called by the SmartSSH relay when a push supplies the learned prompt token. */
    setSmartSSHProposalToken (token: string, trusted = false): void {
        this.smartsshProposalToken = token
        this.smartsshProposalTokenTrusted = trusted
        this.smartsshProposalService?.setToken({ token, tokenTrusted: trusted })
        this.smartsshProposalService?.tick()
    }

    /** Called by the SmartSSH relay with a command that is ready to be offered on the bar. */
    proposeSmartSSHCommand (command: string, risk: 'read'|'write'|'danger' = 'write', why = '', confirmExpected?: string): any {
        if (!this.smartsshProposalService) {
            return { queued: false, reason: 'not-ready' }
        }
        return this.smartsshProposalService.propose({ command, risk, why, confirm_expected: confirmExpected })
    }

    /**
     * Called by whatever receives relay pushes. The relay owns proposal_id/tab_id/session_id, so the
     * app never invents them: the bridge sends back exactly these values on dispatch.
     */
    setSmartSSHRelayContext (context: {proposalId?: string, tabId?: string, sessionId?: string}): void {
        this.smartsshRelayContext = { ...this.smartsshRelayContext, ...context }
        if (context.proposalId !== undefined) {
            this.smartsshRelayBridge?.setProposalId(context.proposalId)
        }
    }

    /** The danger code the user is about to submit; mirrored to the relay on dispatch. */
    noteSmartSSHRelayConfirmCode (code: string): void {
        this.smartsshRelayConfirmCode = code
        this.smartsshRelayBridge?.noteConfirmCode(code)
    }

    /** `online` when a relay client exists, `offline` otherwise. Never includes the token. */
    smartsshRelayStatus (): {status: string, cause?: string} {
        if (!this.smartsshRelayBridge) {
            return { status: 'offline', cause: 'token' }
        }
        return this.smartsshRelayBridge.summary()
    }

    protected stopSmartSSHProposal (): void {
        this.smartsshRelayBridge?.stop()
        this.smartsshRelayBridge = null
        this.smartsshProposalUnsubscribe?.()
        this.smartsshProposalUnsubscribe = null
        this.smartsshProposalService?.stop()
        this.smartsshProposalService = null
        this.smartsshProposal = null
    }

    async buildContextMenu (): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(this)))) {
            items = items.concat(section)
            items.push({ type: 'separator' })
        }
        items.splice(items.length - 1, 1)
        return items
    }

    /**
     * Feeds input into the active session
     */
    sendInput (data: string|Buffer): void {
        if (!(data instanceof Buffer)) {
            data = Buffer.from(data, 'utf-8')
        }
        // A submitted line is a feed: the settler must know, or a dispatched command would look
        // like it never started and a proposal could be offered while output is still coming.
        if (this.smartsshProposalService && (data.includes(0x0d) || data.includes(0x0a))) {
            this.smartsshProposalService.noteFeed()
        }
        this.session?.feedFromTerminal(data)
        if (this.config.store.terminal.scrollOnInput && !data.equals(OSC_FOCUS_IN) && !data.equals(OSC_FOCUS_OUT)) {
            this.frontend?.scrollToBottom()
        }
    }

    /**
     * Feeds input into the terminal frontend
     */
    async write (data: string): Promise<void> {
        this.frontendWriteLock = this.frontendWriteLock.then(() =>
            this.withSpinnerPaused(() => this.writeRaw(data)))
        await this.frontendWriteLock
    }

    protected async writeRaw (data: string): Promise<void> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }

        if (this.config.store.terminal.detectProgress) {
            const percentageMatch = /(^|[^\d])(\d+(\.\d+)?)%([^\d]|$)/.exec(data)
            if (!this.alternateScreenActive && percentageMatch) {
                const percentage = percentageMatch[3] ? parseFloat(percentageMatch[2]) : parseInt(percentageMatch[2])
                if (percentage > 0 && percentage <= 100) {
                    this.setProgress(percentage)
                }
            } else {
                this.setProgress(null)
            }
        }

        await this.frontend.write(data)
    }

    async paste (): Promise<void> {
        let data = this.platform.readClipboard()
        if (this.hostApp.platform === Platform.Windows) {
            data = data.replaceAll('\r\n', '\r')
        } else {
            data = data.replaceAll('\n', '\r')
        }

        if (this.config.store.terminal.replaceNewlinesWithSpacesOnPaste) {
            data = data.replace(/[\r\n]+/g, ' ')
        }

        if (this.config.store.terminal.trimWhitespaceOnPaste && data.indexOf('\n') === data.length - 1) {
            // Ends with a newline and has no other line breaks
            data = data.substring(0, data.length - 1)
        }

        if (!this.alternateScreenActive) {
            if ((data.includes('\r') || data.includes('\n')) && this.config.store.terminal.warnOnMultilinePaste) {
                const buttons = [
                    this.translate.instant('Paste'),
                    this.translate.instant('Cancel'),
                ]
                const result = (await this.platform.showMessageBox(
                    {
                        type: 'warning',
                        detail: data.slice(0, 1000),
                        message: this.translate.instant('Paste multiple lines?'),
                        buttons,
                        defaultId: 0,
                        cancelId: 1,
                    },
                )).response
                if (result === 1) {
                    return
                }
            } else {
                if (this.config.store.terminal.trimWhitespaceOnPaste) {
                    data = data.trimEnd()
                    if (!data.includes('\r')) {
                        data = data.trimStart()
                    }
                }
            }
        }

        if (this.config.store.terminal.bracketedPaste && this.frontend?.supportsBracketedPaste()) {
            data = `\x1b[200~${data}\x1b[201~`
        }
        this.sendInput(data)
    }

    /**
     * Applies the user settings to the terminal
     */
    configure (): void {
        this.frontend?.configure(this.profile)

        this.backgroundColor = getTerminalBackgroundColor(this.config, this.themes, this.profile.terminalColorScheme)
    }

    zoomIn (): void {
        this.zoom++
        this.frontend?.setZoom(this.zoom)
    }

    zoomOut (): void {
        this.zoom--
        this.frontend?.setZoom(this.zoom)
    }

    resetZoom (): void {
        this.zoom = 0
        this.frontend?.setZoom(this.zoom)
    }

    async copyCurrentPath (): Promise<void> {
        let cwd: string|null = null
        if (this.session?.supportsWorkingDirectory()) {
            cwd = await this.session.getWorkingDirectory()
        }
        if (cwd) {
            this.platform.setClipboard({ text: cwd })
            this.notifications.notice(this.translate.instant('Copied'))
        } else {
            this.notifications.error(this.translate.instant('Shell does not support current path detection'))
        }
    }

    /** @hidden */
    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.stopSmartSSHProposal()
        this.stopSpinner()
    }

    async destroy (): Promise<void> {
        // Stop the proposal service while the frontend still exists: its last flush must be able to
        // read a live xterm. Destroying the frontend first (the old order) handed the flush a dead
        // component, so every case fell back to declared CASE_SPEC geometry.
        this.stopSmartSSHProposal()
        this.frontend?.detach(this.content.nativeElement)
        this.frontend?.destroy()
        this.frontend = undefined
        this.content.nativeElement.remove()
        this.detachTermContainerHandlers()
        this.config.enabledServices(this.decorators).forEach(decorator => {
            try {
                decorator.detach(this)
            } catch (e) {
                this.logger.warn('Decorator attach() throws', e)
            }
        })
        this.output.complete()
        this.binaryOutput.complete()
        this.frontendReady.complete()

        super.destroy()
        if (this.session?.open) {
            await this.session.destroy()
        }
    }

    protected detachTermContainerHandlers (): void {
        this.termContainerSubscriptions.cancelAll()
    }

    private rightMouseDownTime = 0

    protected async handleRightMouseDown (event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        this.rightMouseDownTime = Date.now()
        if (this.config.store.terminal.rightClick === 'menu') {
            this.platform.popupContextMenu(await this.buildContextMenu(), event)
        }
    }

    protected async handleRightMouseUp (event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (this.config.store.terminal.rightClick === 'paste'
            || this.config.store.terminal.rightClick === 'clipboard') {
            const duration = Date.now() - this.rightMouseDownTime
            if (duration < 250) {
                if (this.config.store.terminal.rightClick === 'paste') {
                    this.paste()
                } else if (this.config.store.terminal.rightClick === 'clipboard') {
                    if (this.frontend?.getSelection()) {
                        this.frontend.copySelection()
                        this.frontend.clearSelection()
                    } else {
                        this.paste()
                    }
                }
            } else {
                this.platform.popupContextMenu(await this.buildContextMenu(), event)
            }
        }
    }

    protected attachTermContainerHandlers (): void {
        this.detachTermContainerHandlers()

        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }

        const maybeConfigure = () => {
            if (this.hasFocus) {
                setTimeout(() => this.configure(), 250)
            }
        }

        this.termContainerSubscriptions.subscribe(this.frontend.title$, title => this.zone.run(() => {
            if (!this.disableDynamicTitle) {
                this.setTitle(title)
            }
        }))

        this.termContainerSubscriptions.subscribe(this.focused$, () => this.frontend && (this.frontend.enableResizing = true))
        this.termContainerSubscriptions.subscribe(this.blurred$, () => this.frontend && (this.frontend.enableResizing = false))

        this.termContainerSubscriptions.subscribe(this.frontend.mouseEvent$, event => {
            if (event.type === 'mousedown') {
                if (event.which === 1) {
                    this.multifocus.cancel()
                }
                if (event.which === 2) {
                    if (this.config.store.terminal.pasteOnMiddleClick) {
                        this.paste()
                    }
                    event.preventDefault()
                    event.stopPropagation()
                    return
                }
                if (event.which === 3 || event.which === 1 && event.ctrlKey) {
                    this.handleRightMouseDown(event)
                    return
                }
            }
            if (event.type === 'mouseup') {
                if (event.which === 3 || event.which === 1 && event.ctrlKey) {
                    this.handleRightMouseUp(event)
                    return
                }
            }
            if (event.type === 'mousewheel') {
                let wheelDeltaY = 0

                if ('wheelDeltaY' in event) {
                    wheelDeltaY = (event as unknown as WheelEvent)['wheelDeltaY']
                } else {
                    wheelDeltaY = (event as unknown as WheelEvent).deltaY
                }

                if (event.altKey) {
                    event.preventDefault()
                    const delta = Math.round(wheelDeltaY / 50)
                    this.sendInput((delta > 0 ? '\u001bOA' : '\u001bOB').repeat(Math.abs(delta)))
                }
            }
        })

        this.termContainerSubscriptions.subscribe(this.frontend.input$, data => {
            this.sendInput(data)
        })

        this.termContainerSubscriptions.subscribe(this.frontend.resize$.pipe(auditTime(100)), ({ columns, rows }) => {
            this.logger.debug(`Resizing to ${columns}x${rows}`)
            this.size = { columns, rows }
            this.zone.run(() => {
                if (this.session?.open) {
                    this.session.resize(columns, rows)
                }
            })
        })

        this.termContainerSubscriptions.subscribe(this.platform.displayMetricsChanged$, maybeConfigure)
        this.termContainerSubscriptions.subscribe(this.hostWindow.windowMoved$, maybeConfigure)
    }

    setSession (session: BaseSession|null, destroyOnSessionClose = false): void {
        if (session) {
            if (this.session) {
                this.setSession(null)
            }
            this.detachSessionHandlers()
            this.session = session
            this.attachSessionHandlers(destroyOnSessionClose)
        } else {
            this.detachSessionHandlers()
            this.session = null
        }
        this.sessionChanged.next(session)
    }

    showToolbar (): void {
        this.revealToolbar = true
        this.toolbarRevealTimeout.clear()
    }

    hideToolbar (): void {
        this.toolbarRevealTimeout.set()
    }

    togglePinToolbar (): void {
        this.pinToolbar = !this.pinToolbar
        window.localStorage.pinTerminalToolbar = this.pinToolbar
    }

    @HostBinding('class.with-title-inset') get hasTitleInset (): boolean {
        return this.hostApp.platform === Platform.macOS && this.config.store.appearance.tabsLocation !== 'top' && this.config.store.appearance.frame === 'thin'
    }

    protected attachSessionHandler <T> (observable: Observable<T>, handler: (v: T) => void): void {
        this.sessionHandlers.subscribe(observable, handler)
    }

    protected attachSessionHandlers (destroyOnSessionClose = false): void {
        if (!this.session) {
            throw new Error('Session not set')
        }

        // this.session.output$.bufferTime(10).subscribe((datas) => {
        this.attachSessionHandler(this.session.output$, data => {
            if (this.enablePassthrough) {
                this.output.next(data)
                this.write(data)
            }
        })

        this.attachSessionHandler(this.session.binaryOutput$, data => {
            if (this.enablePassthrough) {
                this.binaryOutput.next(data)
            }
        })

        this.attachSessionHandler(this.session.closed$, () => {
            this.onSessionClosed(destroyOnSessionClose)
        })

        this.attachSessionHandler(this.session.destroyed$, () => {
            this.onSessionDestroyed()
        })

        this.attachSessionHandler(this.session.oscProcessor.copyRequested$, content => {
            this.platform.setClipboard({ text: content })
            this.notifications.notice(this.translate.instant('Copied'))
        })
    }

    /**
     * Method called when session is closed.
     */
    protected onSessionClosed (destroyOnSessionClose = false): void {
        // Pinning only guards against manual close (see AppService.closeTab);
        // a shell exiting closes the tab normally per behaviorOnSessionEnd.
        if (destroyOnSessionClose || this.shouldTabBeDestroyedOnSessionClose()) {
            this.destroy()
        }
    }

    /**
     * Return true if tab should be destroyed on session closed.
     */
    protected shouldTabBeDestroyedOnSessionClose (): boolean {
        const behavior = this.profile.behaviorOnSessionEnd
        return behavior === 'close' || behavior === 'auto' && this.isSessionExplicitlyTerminated()
    }

    /**
     * Method called when session is destroyed. Set the session to null
     */
    protected onSessionDestroyed (): void {
        this.setSession(null)
    }

    protected detachSessionHandlers (): void {
        this.sessionHandlers.cancelAll()
    }

    protected startSpinner (text?: string): void {
        if (this.spinnerActive || this.spinnerPaused) {
            return
        }
        if (text) {
            this.spinner.text = text
        }
        this.spinner.setSpinnerString(6)
        this.spinnerActive = true
        this.zone.runOutsideAngular(() => {
            this.spinner.start()
        })
    }

    protected stopSpinner (): void {
        if (!this.spinnerActive) {
            return
        }
        this.spinner.stop(true)
        this.spinnerActive = false
    }

    protected async withSpinnerPaused (work: () => any): Promise<void> {
        this.spinnerPaused = true
        if (this.spinnerActive) {
            this.spinner.stop(true)
        }
        try {
            await work()
        } finally {
            this.spinnerPaused = false
            if (this.spinnerActive) {
                this.zone.runOutsideAngular(() => {
                    this.spinner.start()
                })
            }
        }
    }

    protected forEachFocusedTerminalPane (cb: (tab: BaseTerminalTabComponent<any>) => void): void {
        if (this.parent && this.parent instanceof SplitTabComponent && this.parent._allFocusMode) {
            for (const tab of this.parent.getAllTabs()) {
                if (tab instanceof BaseTerminalTabComponent) {
                    cb(tab)
                }
            }
        } else {
            cb(this)
        }
    }

    /**
     * Return true if the user explicitly exit the session
     */
    protected isSessionExplicitlyTerminated (): boolean {
        return false
    }
}
