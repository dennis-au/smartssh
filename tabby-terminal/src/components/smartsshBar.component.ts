import { Component, Input, Output, EventEmitter, OnChanges } from '@angular/core'
import { barModel, elementPolicy } from '../../../smartssh/core/barModel.mjs'

/**
 * The SmartSSH approval bar.
 *
 * Rendering rules come from one pure model (smartssh/core/barModel.mjs), so "this state has no
 * approve control" is enforced by the model and its unit tests, not by this template. Anything
 * the model does not list is simply not rendered — a control that does not exist cannot be
 * pressed in the wrong state.
 *
 * Layout contract (designer v19): the element is the third row of the pane, in normal flow, never
 * sticky and never an overlay. No proposal => the host does not render this component at all;
 * a terminal state keeps it mounted and collapses its height, so xterm resizes once, not twice.
 */
@Component({
    selector: 'smartssh-bar',
    template: `
    <section class="smartssh-bar"
             [attr.data-state]="attrs['data-state']"
             [attr.data-risk]="attrs['data-risk']"
             [attr.data-gate]="attrs['data-gate']"
             [attr.data-gate-reason]="attrs['data-gate-reason']"
             [attr.data-auto-run]="attrs['data-auto-run']"
             [attr.data-viewport]="attrs['data-viewport']"
             [attr.data-cause]="attrs['data-cause']"
             [attr.data-exit-code]="attrs['data-exit-code']"
             aria-live="off">
        <div class="bar-h" role="status" aria-live="polite">
            <span class="who">Hermes 提案</span>
            <span class="chip">{{ riskLabel }}</span>
            <span class="tm" *ngIf="time">{{ time }}</span>
            <span class="keys">{{ hintKeys }}</span>
        </div>

        <button class="cmd" type="button" [title]="command">{{ command }}</button>
        <p class="why" *ngIf="why">{{ why }}</p>

        <div class="acts">
            <button *ngIf="has('approve')" class="btn primary" (click)="approve.emit()">批准 <kbd>Enter</kbd></button>
            <button *ngIf="has('confirm_code')" class="btn danger" (click)="approve.emit()">確認碼</button>
            <button *ngIf="has('run_now')" class="btn primary" (click)="runNow.emit()">即刻跑</button>
            <button *ngIf="has('cancel')" class="btn" (click)="cancel.emit()">停 <kbd>Esc</kbd></button>
            <button *ngIf="has('reject')" class="btn" (click)="reject.emit()">唔好 <kbd>Esc</kbd></button>
            <button *ngIf="has('ctrl_c')" class="btn warn" (click)="ctrlC.emit()">Ctrl+C 斷</button>
            <button *ngIf="has('reset_token')" class="btn danger" (click)="resetToken.emit()">重設 token <kbd>T</kbd></button>
            <button *ngIf="has('retry')" class="btn" (click)="retry.emit()">重試 <kbd>R</kbd></button>
            <button *ngIf="has('copy_diag')" class="btn" (click)="copyDiag.emit()">複製診斷 <kbd>C</kbd></button>
            <button *ngIf="has('ask_again')" class="btn" (click)="askAgain.emit()">再問 <kbd>R</kbd></button>
            <button *ngIf="has('expand')" class="btn link" (click)="expand.emit()">全文 <kbd>F</kbd></button>
            <button *ngIf="has('dismiss')" class="btn link" (click)="dismiss.emit()">收 <kbd>Esc</kbd></button>
        </div>
    </section>
    `,
    styleUrls: ['./smartsshBar.component.scss'],
})
export class SmartSSHBarComponent implements OnChanges {
    @Input() model: any
    @Output() approve = new EventEmitter<void>()
    @Output() runNow = new EventEmitter<void>()
    @Output() cancel = new EventEmitter<void>()
    @Output() reject = new EventEmitter<void>()
    @Output() ctrlC = new EventEmitter<void>()
    @Output() resetToken = new EventEmitter<void>()
    @Output() retry = new EventEmitter<void>()
    @Output() copyDiag = new EventEmitter<void>()
    @Output() askAgain = new EventEmitter<void>()
    @Output() expand = new EventEmitter<void>()
    @Output() dismiss = new EventEmitter<void>()

    attrs: Record<string, string> = {}
    controls: string[] = []
    policy = 'absent'

    get command (): string { return this.model?.command ?? '' }
    get why (): string { return this.model?.why ?? '' }
    get time (): string { return this.model?.time ?? '' }

    get riskLabel (): string {
        return { read: '讀取', write: '寫入', danger: '危險' }[this.model?.risk] ?? ''
    }

    get hintKeys (): string {
        const map: Record<string, string> = {
            proposed: this.model?.risk === 'danger' ? '確認碼 · Esc' : 'Enter · Esc',
            counting: 'Esc 停',
            executing: 'Ctrl+C 斷',
            rejected: 'Esc · R',
            aborted: 'Esc · R',
            expired: 'Esc · R',
            offline: this.model?.cause === 'token' ? 'T · C · Esc' : 'R · C · Esc',
        }
        return map[this.attrs['data-state']] ?? ''
    }

    ngOnChanges (): void {
        if (!this.model) { this.attrs = {}; this.controls = []; this.policy = 'absent'; return }
        const built = barModel(this.model)
        this.attrs = built.attrs
        this.controls = built.controls
        this.policy = elementPolicy(built.attrs['data-state'], true)
    }

    has (control: string): boolean { return this.controls.includes(control) }
}
