// Runs a JavaScript expression in the ChaX Windows app over the DevTools protocol (start it with `ChaX.exe --debug`).
// usage: node tools/cdp.mjs "<expression>"
const tabs = await (await fetch('http://localhost:9222/json')).json();
const page = tabs.find((t) => t.type === 'page');
if (!page) throw new Error('no page: is ChaX.exe running with --debug?');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => (ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
console.log(JSON.stringify(msg.result?.result?.value ?? msg.result ?? msg.error));
ws.close();
