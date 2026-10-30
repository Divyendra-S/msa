// Stands in for the scripts Tauri injects into its own web view, for a page served by
// windtunnel-tauri: `invoke` becomes `POST /__windtunnel/invoke/<command>`, so a test harness can
// hold, delay or repeat each call, and the app's events arrive as a server-sent event stream.
// Mirrors what @tauri-apps/api v2 expects of `window.__TAURI_INTERNALS__`.
;(function () {
  const label = __WINDTUNNEL_LABEL__

  const callbacks = new Map()
  function uid() {
    return window.crypto.getRandomValues(new Uint32Array(1))[0]
  }
  function transformCallback(callback, once = false) {
    const id = uid()
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id)
      return callback && callback(data)
    })
    return id
  }
  function unregisterCallback(id) {
    callbacks.delete(id)
  }
  function runCallback(id, data) {
    const callback = callbacks.get(id)
    if (callback) callback(data)
  }

  // Listeners by event name: listener id → callback id.
  const listeners = new Map()
  let nextListener = 1
  let stream
  function connect() {
    if (!stream) {
      stream = new Promise((resolve) => {
        const source = new EventSource('/__windtunnel/events')
        source.onopen = () => resolve(source)
        source.onmessage = (message) => {
          const { event, payload } = JSON.parse(message.data)
          for (const [id, callback] of listeners.get(event) || []) runCallback(callback, { event, payload, id })
        }
      })
    }
    return stream
  }
  async function listen(event, callback) {
    if (!listeners.has(event)) {
      listeners.set(event, new Map())
      await fetch('/__windtunnel/listen', { method: 'POST', body: JSON.stringify({ event }) })
    }
    await connect()
    const id = nextListener++
    listeners.get(event).set(id, callback)
    return id
  }
  function unregisterListener(event, id) {
    const callback = listeners.get(event)?.get(id)
    if (callback !== undefined) unregisterCallback(callback)
    listeners.get(event)?.delete(id)
  }

  function encode(payload) {
    if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) return { type: 'application/octet-stream', body: payload }
    if (Array.isArray(payload)) return { type: 'application/octet-stream', body: new Uint8Array(payload) }
    const body = JSON.stringify(payload, (_key, value) => {
      if (value instanceof Map) return Object.fromEntries(value.entries())
      if (value instanceof Uint8Array) return Array.from(value)
      if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
      if (typeof value === 'object' && value !== null && '__TAURI_TO_IPC_KEY__' in value) return value.__TAURI_TO_IPC_KEY__()
      return value
    })
    return { type: 'application/json', body }
  }

  async function invoke(cmd, payload = {}, options) {
    // Events are wired here; emitting one is a call like any other.
    if (cmd === 'plugin:event|listen') return listen(payload.event, payload.handler)
    if (cmd === 'plugin:event|unlisten') return unregisterListener(payload.event, payload.eventId)
    const { type, body } = encode(payload)
    const headers = new Headers((options && options.headers) || {})
    headers.set('Content-Type', type)
    const response = await fetch('/__windtunnel/invoke/' + encodeURIComponent(cmd), { method: 'POST', body, headers })
    const kind = (response.headers.get('content-type') || '').split(',')[0]
    const value =
      kind === 'application/json' ? await response.json() : kind.startsWith('text/') ? await response.text() : await response.arrayBuffer()
    if (response.ok && response.headers.get('Tauri-Response') !== 'error') return value
    throw value
  }

  function convertFileSrc(filePath, protocol = 'asset') {
    return `${protocol}://localhost/${encodeURIComponent(filePath)}`
  }

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      invoke,
      transformCallback,
      unregisterCallback,
      runCallback,
      callbacks,
      convertFileSrc,
      metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
      plugins: {},
    },
  })
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener } })

  // `app.withGlobalTauri`: the core and event parts of `window.__TAURI__`.
  if (__WINDTUNNEL_GLOBAL_TAURI__) {
    const listenFor = async (event, handler, once) => {
      let id
      const callback = transformCallback((data) => {
        if (once) unregisterListener(event, id)
        handler(data)
      })
      id = await listen(event, callback)
      return () => unregisterListener(event, id)
    }
    window.__TAURI__ = {
      core: { invoke, transformCallback, convertFileSrc },
      event: {
        listen: (event, handler) => listenFor(event, handler, false),
        once: (event, handler) => listenFor(event, handler, true),
        emit: (event, payload) => invoke('plugin:event|emit', { event, payload }),
      },
    }
  }
})()
