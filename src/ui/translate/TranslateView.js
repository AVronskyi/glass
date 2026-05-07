import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';

export class TranslateView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 460px;
            transform: translate3d(0, 0, 0);
            backface-visibility: hidden;
            transition: transform 0.2s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.2s ease-out;
            will-change: transform, opacity;
        }

        * {
            font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: default;
            user-select: none;
            box-sizing: border-box;
        }

        .translate-container {
            display: flex;
            flex-direction: column;
            color: #ffffff;
            position: relative;
            background: rgba(0, 0, 0, 0.62);
            overflow: hidden;
            border-radius: 12px;
            width: 100%;
            height: 100%;
            min-height: 220px;
        }

        .translate-container::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 12px;
            padding: 1px;
            background: linear-gradient(169deg, rgba(255, 255, 255, 0.17) 0%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.17) 100%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: destination-out;
            mask-composite: exclude;
            pointer-events: none;
        }

        .top-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 36px;
            padding: 6px 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            flex-shrink: 0;
            position: relative;
            z-index: 1;
        }

        .title-group {
            display: flex;
            flex-direction: column;
            min-width: 0;
            gap: 2px;
        }

        .title {
            color: white;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .status {
            color: rgba(255, 255, 255, 0.62);
            font-size: 10px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 260px;
        }

        .bar-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        .timer {
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.7);
        }

        .copy-button {
            background: transparent;
            color: rgba(255, 255, 255, 0.9);
            border: none;
            outline: none;
            padding: 4px;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            transition: background-color 0.15s ease;
            position: relative;
        }

        .copy-button:hover {
            background: rgba(255, 255, 255, 0.15);
        }

        .copy-button svg {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
        }

        .copy-button .check-icon {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .copy-icon {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .check-icon {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        .content {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px;
            overflow-y: auto;
            max-height: 660px;
            min-height: 180px;
            position: relative;
            z-index: 1;
            user-select: text;
            cursor: text;
        }

        .content * {
            user-select: text;
            cursor: text;
        }

        .content::-webkit-scrollbar {
            width: 8px;
        }

        .content::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 4px;
        }

        .content::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }

        .translation-card {
            display: flex;
            flex-direction: column;
            gap: 7px;
            padding: 10px 12px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.09);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .translation-text {
            color: rgba(255, 255, 255, 0.96);
            font-size: 16px;
            line-height: 1.42;
            letter-spacing: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .streaming-cursor {
            display: inline-block;
            width: 7px;
            margin-left: 2px;
            color: rgba(255, 255, 255, 0.85);
            animation: blink 0.85s steps(2, start) infinite;
        }

        @keyframes blink {
            to { visibility: hidden; }
        }

        .source-text {
            color: rgba(255, 255, 255, 0.52);
            font-size: 11px;
            line-height: 1.35;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .partial {
            padding: 9px 11px;
            border-radius: 8px;
            border: 1px dashed rgba(255, 255, 255, 0.16);
            color: rgba(255, 255, 255, 0.58);
            font-size: 12px;
            line-height: 1.4;
            overflow-wrap: anywhere;
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 140px;
            color: rgba(255, 255, 255, 0.55);
            font-size: 12px;
            font-style: italic;
        }

        :host-context(body.has-glass) .translate-container,
        :host-context(body.has-glass) .top-bar,
        :host-context(body.has-glass) .copy-button,
        :host-context(body.has-glass) .translation-card,
        :host-context(body.has-glass) .partial {
            background: transparent !important;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            filter: none !important;
            backdrop-filter: none !important;
        }

        :host-context(body.has-glass) .translate-container::after {
            display: none !important;
        }

        :host-context(body.has-glass) * {
            animation: none !important;
            transition: none !important;
            transform: none !important;
            filter: none !important;
            backdrop-filter: none !important;
            box-shadow: none !important;
        }

        :host-context(body.has-glass) .translate-container,
        :host-context(body.has-glass) .translation-card,
        :host-context(body.has-glass) .copy-button {
            border-radius: 0 !important;
        }

        :host-context(body.has-glass) ::-webkit-scrollbar,
        :host-context(body.has-glass) ::-webkit-scrollbar-track,
        :host-context(body.has-glass) ::-webkit-scrollbar-thumb {
            background: transparent !important;
            width: 0 !important;
        }
    `;

    static properties = {
        translations: { type: Array },
        partialTranscript: { type: String },
        statusText: { type: String },
        elapsedTime: { type: String },
        isSessionActive: { type: Boolean },
        copyState: { type: String },
    };

    constructor() {
        super();
        this.translations = [];
        this.partialTranscript = '';
        this.statusText = 'Idle';
        this.elapsedTime = '00:00';
        this.isSessionActive = false;
        this.copyState = 'idle';
        this.timerInterval = null;
        this.captureStartTime = null;
        this.copyTimeout = null;
        this.adjustHeightThrottle = null;
        this.isThrottled = false;

        this.handleSessionStateChanged = this.handleSessionStateChanged.bind(this);
        this.handleTranscriptUpdate = this.handleTranscriptUpdate.bind(this);
        this.handleTranslationUpdate = this.handleTranslationUpdate.bind(this);
        this.handleStatusUpdate = this.handleStatusUpdate.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.api) {
            window.api.translateView.onSessionStateChanged(this.handleSessionStateChanged);
            window.api.translateView.onTranscriptUpdate(this.handleTranscriptUpdate);
            window.api.translateView.onTranslationUpdate(this.handleTranslationUpdate);
            window.api.translateView.onStatusUpdate(this.handleStatusUpdate);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this.stopTimer();

        if (this.copyTimeout) {
            clearTimeout(this.copyTimeout);
        }
        if (this.adjustHeightThrottle) {
            clearTimeout(this.adjustHeightThrottle);
        }

        if (window.api) {
            window.api.translateView.removeOnSessionStateChanged(this.handleSessionStateChanged);
            window.api.translateView.removeOnTranscriptUpdate(this.handleTranscriptUpdate);
            window.api.translateView.removeOnTranslationUpdate(this.handleTranslationUpdate);
            window.api.translateView.removeOnStatusUpdate(this.handleStatusUpdate);
        }
    }

    handleSessionStateChanged(event, { isActive }) {
        const wasActive = this.isSessionActive;
        this.isSessionActive = isActive;

        if (!wasActive && isActive) {
            this.translations = [];
            this.partialTranscript = '';
            this.statusText = 'Listening for English...';
            this.startTimer();
        }

        if (wasActive && !isActive) {
            this.partialTranscript = '';
            this.stopTimer();
        }

        this.requestUpdate();
        this.adjustWindowHeightThrottled();
    }

    handleTranscriptUpdate(event, { text, isPartial, isFinal }) {
        if (isPartial) {
            this.partialTranscript = text || '';
        } else if (isFinal) {
            this.partialTranscript = '';
        }

        this.requestUpdate();
        this.adjustWindowHeightThrottled();
    }

    handleTranslationUpdate(event, update) {
        if (!update || !update.id) return;

        const nextTranslations = [...this.translations];
        const existingIndex = nextTranslations.findIndex(item => item.id === update.id);
        const nextItem = {
            id: update.id,
            sourceText: update.sourceText || '',
            translation: update.translation || '',
            isStreaming: !!update.isStreaming,
            isFinal: !!update.isFinal,
            error: update.error || null,
        };

        if (existingIndex === -1) {
            nextTranslations.push(nextItem);
        } else {
            nextTranslations[existingIndex] = {
                ...nextTranslations[existingIndex],
                ...nextItem,
            };
        }

        this.translations = nextTranslations;
        this.requestUpdate();
        this.adjustWindowHeightThrottled();
        this.scrollToBottom();
    }

    handleStatusUpdate(event, { status }) {
        this.statusText = status || '';
        this.requestUpdate();
    }

    startTimer() {
        this.captureStartTime = Date.now();
        this.elapsedTime = '00:00';
        this.stopTimer();
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.captureStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            this.elapsedTime = `${minutes}:${seconds}`;
            this.requestUpdate();
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    getCopyText() {
        return this.translations
            .filter(item => item.translation || item.sourceText)
            .map(item => [
                item.translation || '',
                item.sourceText ? `EN: ${item.sourceText}` : '',
            ].filter(Boolean).join('\n'))
            .join('\n\n');
    }

    async handleCopy() {
        if (this.copyState === 'copied') return;

        try {
            await navigator.clipboard.writeText(this.getCopyText());
            this.copyState = 'copied';
            this.requestUpdate();

            if (this.copyTimeout) {
                clearTimeout(this.copyTimeout);
            }
            this.copyTimeout = setTimeout(() => {
                this.copyState = 'idle';
                this.requestUpdate();
            }, 1500);
        } catch (error) {
            console.error('Failed to copy translation:', error);
        }
    }

    adjustWindowHeight() {
        if (!window.api) return;

        this.updateComplete
            .then(() => {
                const topBar = this.shadowRoot.querySelector('.top-bar');
                const content = this.shadowRoot.querySelector('.content');
                if (!topBar || !content) return;

                const idealHeight = topBar.offsetHeight + content.scrollHeight;
                const targetHeight = Math.min(700, Math.max(220, idealHeight));
                window.api.translateView.adjustWindowHeight('translate', targetHeight);
            })
            .catch(error => {
                console.error('Error adjusting translate window height:', error);
            });
    }

    adjustWindowHeightThrottled() {
        if (this.isThrottled) return;

        this.adjustWindowHeight();
        this.isThrottled = true;

        this.adjustHeightThrottle = setTimeout(() => {
            this.isThrottled = false;
        }, 16);
    }

    scrollToBottom() {
        setTimeout(() => {
            const content = this.shadowRoot.querySelector('.content');
            if (content) {
                content.scrollTop = content.scrollHeight;
            }
        }, 0);
    }

    firstUpdated() {
        super.firstUpdated();
        setTimeout(() => this.adjustWindowHeight(), 200);
    }

    renderTranslation(item) {
        const text = item.translation || '';
        return html`
            <div class="translation-card">
                <div class="translation-text">${text || '…'}${item.isStreaming
                    ? html`<span class="streaming-cursor">▍</span>`
                    : html``}</div>
                <div class="source-text">${item.sourceText}</div>
            </div>
        `;
    }

    render() {
        return html`
            <div class="translate-container">
                <div class="top-bar">
                    <div class="title-group">
                        <div class="title">English -> Ukrainian</div>
                        <div class="status">${this.statusText}</div>
                    </div>
                    <div class="bar-controls">
                        <div class="timer">${this.elapsedTime}</div>
                        <button
                            class="copy-button ${this.copyState === 'copied' ? 'copied' : ''}"
                            @click=${this.handleCopy}
                        >
                            <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                            <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M20 6L9 17l-5-5" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="content">
                    ${this.translations.length === 0
                        ? html`<div class="empty-state">Waiting for English audio...</div>`
                        : html`${this.translations.map(item => this.renderTranslation(item))}`}
                </div>
            </div>
        `;
    }
}

customElements.define('translate-view', TranslateView);
