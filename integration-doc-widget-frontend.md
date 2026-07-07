# Hypersign Widget Frontend Integration

This quick guide assumes you already have a complete Hypersign widget URL.

The widget URL should already include every query parameter required by Hypersign, for example:

```text
https://verify.hypersign.id?kycAccessToken=...&ssiAccessToken=...&sessionId=...&kycUserAccessToken=...
```

Your frontend can open that URL in a popup window or render it inside an iframe, then listen for the result message.

## Flow

1. Receive or generate the complete Hypersign widget URL in your app.
2. Open the URL in a popup window or load it into an iframe.
3. Show a waiting state while the user completes verification.
4. Listen for the widget response in your event listener callback.
5. Read the verification result from `event.data`.
6. If iframe mode was used, close/unload the iframe after receiving the status.
7. If `event.data.status` is `success`, mark the user as verified.
8. If `event.data.status` is `error`, show or handle the error message.

## Minimal HTML

```html
<button id="open-window-btn" type="button">
  Open in Window
</button>

<button id="open-iframe-btn" type="button">
  Open as Iframe
</button>

<div id="widget-iframe-container" hidden>
  <iframe
    id="widget-iframe"
    title="Hypersign KYC Widget"
    style="width: 100%; height: 900px; border: 0;"
    allow="camera; microphone; fullscreen; clipboard-read; clipboard-write"
  ></iframe>
</div>
```

## Minimal JavaScript

```html
<script>
  const hypersignWidgetUrl =
    "https://verify.hypersign.id?kycAccessToken=...&ssiAccessToken=...&sessionId=...&kycUserAccessToken=...";

  let widgetWindow = null;
  let widgetCloseTimer = null;
  let widgetMode = null;

  const openWindowBtn = document.getElementById("open-window-btn");
  const openIframeBtn = document.getElementById("open-iframe-btn");
  const widgetIframeContainer = document.getElementById("widget-iframe-container");
  const widgetIframe = document.getElementById("widget-iframe");

  openWindowBtn.addEventListener("click", () => {
    widgetMode = "window";
    widgetWindow = window.open(
      hypersignWidgetUrl,
      "hypersignKycWidget",
      "width=440,height=900"
    );

    if (!widgetWindow) {
      alert("Popup blocked. Please allow popups for this site.");
      return;
    }

    setWaitingState();
    widgetWindow.focus();

    widgetCloseTimer = window.setInterval(() => {
      if (!widgetWindow || widgetWindow.closed) {
        resetWidget();
      }
    }, 700);
  });

  openIframeBtn.addEventListener("click", () => {
    widgetMode = "iframe";
    widgetIframe.src = hypersignWidgetUrl;
    widgetIframeContainer.hidden = false;
    setWaitingState();
  });

  window.addEventListener("message", (event) => {
    const expectedOrigin = new URL(hypersignWidgetUrl).origin;

    if (event.origin !== expectedOrigin) {
      return;
    }

    window.clearInterval(widgetCloseTimer);
    widgetWindow = null;

    const widgetResult = event.data;
    console.log("Hypersign widget result:", widgetResult);

    if (widgetMode === "iframe") {
      closeIframeWidget();
    }

    if (widgetResult.status === "success") {
      setVerifiedState();
      return;
    }

    if (widgetResult.status === "error") {
      setErrorState(widgetResult.message || "Verification failed.");
      return;
    }

    setErrorState("Unknown widget response.");
  });

  function resetWidget() {
    window.clearInterval(widgetCloseTimer);
    widgetWindow = null;
    widgetMode = null;
    closeIframeWidget();

    openWindowBtn.disabled = false;
    openIframeBtn.disabled = false;
    openWindowBtn.innerText = "Open in Window";
    openIframeBtn.innerText = "Open as Iframe";
  }

  function closeIframeWidget() {
    widgetIframe.removeAttribute("src");
    widgetIframeContainer.hidden = true;
  }

  function setWaitingState() {
    openWindowBtn.disabled = true;
    openIframeBtn.disabled = true;
    openWindowBtn.innerText = "Waiting for user...";
    openIframeBtn.innerText = "Waiting for user...";
  }

  function setVerifiedState() {
    openWindowBtn.disabled = true;
    openIframeBtn.disabled = true;
    openWindowBtn.innerText = "Verified";
    openIframeBtn.innerText = "Verified";
  }

  function setErrorState(message) {
    openWindowBtn.disabled = false;
    openIframeBtn.disabled = false;
    openWindowBtn.innerText = "Try Again";
    openIframeBtn.innerText = "Try Again";
    alert(message);
  }
</script>
```

## Handling Widget Messages

The widget sends its final result to your page through `window.postMessage`. Read the payload from `event.data`.

There are two possible statuses:

- `success`: verification finished successfully.
- `error`: verification failed or could not be completed.

Success response:

```json
{
  "status": "success",
  "message": "Verification completed successfully"
}
```

Error response:

```json
{
  "status": "error",
  "message": "Verification failed"
}
```

Recommended handling:

```js
window.addEventListener("message", (event) => {
  const expectedOrigin = new URL(hypersignWidgetUrl).origin;

  if (event.origin !== expectedOrigin) {
    return;
  }

  const result = event.data;

  if (result.status === "success") {
    // Mark the user as verified in your app.
    return;
  }

  if (result.status === "error") {
    // Show result.message or send it to your backend for logging.
    return;
  }
});
```

## Required Widget URL

Use the full hosted widget URL exactly as provided by your backend or integration layer.

It typically includes:

- `kycAccessToken`
- `ssiAccessToken`
- `sessionId`
- `kycUserAccessToken`

Do not build this URL in browser code if doing so requires API secrets. Secrets should stay on your backend.

## Notes

- Open the popup directly from a user click; browsers often block popups opened later from async callbacks.
- Iframe mode requires the hosted widget to allow cross-origin framing. If the widget server sends frame-blocking headers or frame-busting JavaScript, use the popup flow instead.
- For iframe mode, include camera and microphone permissions in the iframe `allow` attribute.
- Always validate `event.origin` before trusting messages from `window.postMessage`.
- The widget response is available in `event.data`; store it, forward it to your backend, or use it to update your app state.
- Keep the popup dimensions tall enough for the verification flow. `width=440,height=900` is a good starting point.
