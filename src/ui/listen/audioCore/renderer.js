// renderer.js
const listenCapture = require('./listenCapture.js');
const params        = new URLSearchParams(window.location.search);
const isListenView  = params.get('view') === 'listen';
const isTranslateView = params.get('view') === 'translate';


window.pickleGlass = {
    startCapture: listenCapture.startCapture,
    stopCapture: listenCapture.stopCapture,
    isLinux: listenCapture.isLinux,
    isMacOS: listenCapture.isMacOS,
    captureManualScreenshot: listenCapture.captureManualScreenshot,
    getCurrentScreenshot: listenCapture.getCurrentScreenshot,
};


function handleCaptureStateChange(expectedView, label, status) {
    if (!expectedView) {
        console.log(`[Renderer] Non-${label} view: ignoring capture-state change`);
        return;
    }
    if (status === "stop") {
        console.log('[Renderer] Session ended – stopping local capture');
        listenCapture.stopCapture();
    } else {
        console.log('[Renderer] Session initialized – starting local capture');
        listenCapture.startCapture();
    }
}

window.api.renderer.onChangeListenCaptureState((_event, { status }) => {
    handleCaptureStateChange(isListenView, 'listen', status);
});

window.api.renderer.onChangeTranslateCaptureState?.((_event, { status }) => {
    handleCaptureStateChange(isTranslateView, 'translate', status);
});
