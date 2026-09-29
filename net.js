/* Shared peer-to-peer layer. Every game on this site uses it.
 *
 * One player hosts and gets a 4-character room code; the other joins with it.
 * PeerJS's free signalling server only introduces the two browsers — once
 * they're connected the game data goes straight between them, so there is
 * no account and no server of ours in the middle.
 *
 *   const net = GameNet.host({ onCode, onReady, onData, onDrop, onError });
 *   const net = GameNet.join("QK4T", { ... });
 *   net.send({ type: "move", col: 3 });
 *   net.close();
 *
 * Callbacks (all optional):
 *   onCode(code)   host only, once the code is reserved
 *   onReady(role)  both, when the other side is connected. role: "host" | "guest"
 *   onData(msg)    a message from the other side (already JSON-parsed)
 *   onDrop()       the connection went away after having been established
 *   onError(text)  human-readable failure; the session is finished
 */
window.GameNet = (function () {
  "use strict";

  // No O/0, I/1, or S/5 — these get read aloud and typed by hand.
  var ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
  var PREFIX = "sgr-";          // namespaces us on the shared public server
  var JOIN_TIMEOUT = 15000;
  var MAX_ID_RETRIES = 5;

  function randomCode(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function noop() {}

  function normalise(h) {
    return {
      onCode: h.onCode || noop,
      onReady: h.onReady || noop,
      onData: h.onData || noop,
      onDrop: h.onDrop || noop,
      onError: h.onError || noop
    };
  }

  function supported() {
    return typeof window.Peer === "function" && typeof window.RTCPeerConnection === "function";
  }

  /* Wraps a live DataConnection into the object games talk to. */
  function wire(peer, conn, h, role, session) {
    var live = false;

    conn.on("open", function () {
      live = true;
      session.ready = true;
      h.onReady(role);
    });

    conn.on("data", function (raw) {
      var msg = raw;
      if (typeof raw === "string") {
        try { msg = JSON.parse(raw); } catch (e) { return; }
      }
      if (msg && typeof msg === "object") h.onData(msg);
    });

    conn.on("close", function () {
      if (live && !session.closed) { live = false; h.onDrop(); }
    });

    conn.on("error", function () {
      if (live && !session.closed) { live = false; h.onDrop(); }
    });

    session.conn = conn;
    session.send = function (msg) {
      if (!live || session.closed) return false;
      try { conn.send(JSON.stringify(msg)); return true; }
      catch (e) { return false; }
    };
  }

  function makeSession(peer) {
    var session = {
      ready: false,
      closed: false,
      conn: null,
      send: function () { return false; },
      close: function () {
        session.closed = true;
        try { if (session.conn) session.conn.close(); } catch (e) {}
        try { peer.destroy(); } catch (e) {}
      }
    };
    return session;
  }

  function host(handlers) {
    var h = normalise(handlers);
    if (!supported()) { h.onError("This browser can't make a direct connection. Try Chrome, Safari or Firefox."); return null; }

    var peer = null;
    var session = null;
    var attempts = 0;
    var code = null;

    function attempt() {
      attempts++;
      code = randomCode(4);
      peer = new window.Peer(PREFIX + code, { debug: 0 });
      if (!session) session = makeSession(peer);

      peer.on("open", function () { h.onCode(code); });

      peer.on("connection", function (conn) {
        // One guest at a time. A second knock gets shut out.
        if (session.conn) { try { conn.close(); } catch (e) {} return; }
        wire(peer, conn, h, "host", session);
      });

      peer.on("error", function (err) {
        var type = err && err.type;
        if (type === "unavailable-id" && attempts < MAX_ID_RETRIES) {
          try { peer.destroy(); } catch (e) {}
          attempt();
          return;
        }
        if (session.ready) return;   // post-connection blips are onDrop's problem
        if (type === "browser-incompatible") h.onError("This browser can't make a direct connection. Try Chrome, Safari or Firefox.");
        else if (type === "network" || type === "server-error" || type === "socket-error") h.onError("Couldn't reach the matchmaking server. Check your connection and try again.");
        else h.onError("Couldn't start a game. Reload and try again.");
      });

      peer.on("disconnected", function () {
        // Signalling dropped; an established game keeps running without it.
        if (!session.ready && !session.closed) { try { peer.reconnect(); } catch (e) {} }
      });
    }

    attempt();
    return {
      send: function (m) { return session.send(m); },
      close: function () { session.close(); },
      isReady: function () { return session.ready; }
    };
  }

  function join(rawCode, handlers) {
    var h = normalise(handlers);
    if (!supported()) { h.onError("This browser can't make a direct connection. Try Chrome, Safari or Firefox."); return null; }

    var code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 4) { h.onError("A room code is 4 characters."); return null; }

    var peer = new window.Peer({ debug: 0 });
    var session = makeSession(peer);
    var settled = false;

    var timer = setTimeout(function () {
      if (settled || session.ready || session.closed) return;
      settled = true;
      session.close();
      h.onError("No answer from room " + code + ". Check the code, and that they still have the page open.");
    }, JOIN_TIMEOUT);

    peer.on("open", function () {
      var conn = peer.connect(PREFIX + code, { reliable: true });
      if (!conn) { clearTimeout(timer); settled = true; h.onError("Couldn't open a connection. Reload and try again."); return; }
      conn.on("open", function () { clearTimeout(timer); settled = true; });
      wire(peer, conn, h, "guest", session);
    });

    peer.on("error", function (err) {
      var type = err && err.type;
      if (session.ready || session.closed) return;
      if (type === "peer-unavailable") {
        clearTimeout(timer); settled = true; session.close();
        h.onError("No game found with code " + code + ".");
      } else if (type === "browser-incompatible") {
        clearTimeout(timer); settled = true;
        h.onError("This browser can't make a direct connection. Try Chrome, Safari or Firefox.");
      } else if (type === "network" || type === "server-error" || type === "socket-error") {
        clearTimeout(timer); settled = true;
        h.onError("Couldn't reach the matchmaking server. Check your connection and try again.");
      }
    });

    return {
      send: function (m) { return session.send(m); },
      close: function () { clearTimeout(timer); session.close(); },
      isReady: function () { return session.ready; }
    };
  }

  /* Small helper: games put their lobby markup through this so every
     game handles hosting, joining and errors the same way. */
  function lobby(els, onConnected) {
    var net = null;

    function fail(text) {
      els.error.textContent = text;
      els.error.hidden = false;
      els.hostBtn.disabled = false;
      els.joinBtn.disabled = false;
      els.codePlate.hidden = true;
      net = null;
    }

    function clearError() { els.error.hidden = true; els.error.textContent = ""; }

    var handlers = {
      onCode: function (code) {
        els.codeText.textContent = code;
        els.codePlate.hidden = false;
      },
      onReady: function (role) {
        els.panel.hidden = true;
        onConnected(net, role);
      },
      onError: fail,
      onDrop: function () {}   // replaced by the game once connected
    };

    els.hostBtn.addEventListener("click", function () {
      clearError();
      els.hostBtn.disabled = true;
      els.joinBtn.disabled = true;
      els.hostBtn.textContent = "Waiting for them…";
      net = host(handlers);
    });

    els.joinBtn.addEventListener("click", function () {
      clearError();
      var code = els.codeInput.value.trim();
      if (!code) { fail("Enter the code they sent you."); return; }
      els.hostBtn.disabled = true;
      els.joinBtn.disabled = true;
      els.joinBtn.textContent = "Connecting…";
      net = join(code, handlers);
      if (!net) { els.joinBtn.textContent = "Join"; }
    });

    els.codeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") els.joinBtn.click();
    });

    return { setHandlers: function (o) { Object.assign(handlers, o); } };
  }

  return { host: host, join: join, lobby: lobby, randomCode: randomCode };
})();
