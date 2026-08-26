// ============================================================
//  HereIAm · 语音对讲（内置对讲机）
//  复用现有 WebRTC 点对点连接：把麦克风音频 addTrack 到同一 pc，
//  音频 RTP 点对点直传（不经服务器 / Ably）；
//  首次开麦时经 Ably 信令做一次 renegotiation。
//  对讲控制状态（静音 / 按键 / 说话中）走已有数据通道 P2P。
//  主页面共用：index.html（分享/查看二合一）。
//
//  页面接入步骤：
//    1) const voice = createVoiceController(() => ({ pc, dc, signaling }));
//    2) bindVoiceUI(voice);                         // 绑定对讲 UI
//    3) 创建 pc 后设置：pc.ontrack = e => voice.handleRemoteTrack(e);
//    4) dc.onmessage 里转发：if (m.type === "voice") voice.handleControl(m);
//    5) 收到重协商 offer 时（连接已建立且 stable）：调用 answerVoice(…)。
//    6) 退出/断连时：voice.reset()。
// ============================================================

function createVoiceController(getConn) {
  var v = {
    getConn: getConn,              // () => 连接对象 或 连接对象数组（分享端返回全部好友连接）
    stream: null,                  // 本地麦克风流
    enabled: false,                // 是否已开启语音
    mode: "ptt",                   // "ptt" 按键说话 | "continuous" 免提持续
    pttHeld: false,                // 按键说话：是否正按住
    contOn: false,                 // 免提持续：麦克风是否"开口"
    muted: false,                  // 本机静音
    remoteTalking: false,          // 对方当前是否在说话
    remoteMuted: false,            // 对方是否已静音
    remoteAudio: null,             // 远端音频播放元素
    sentSpeaking: null,            // 上次已上报的 speaking 状态
    micError: null,                // 上次麦克风错误提示
    renegotiating: false,          // 正在重协商，防止并发
    onUi: null,                    // 状态变化回调（页面刷新 UI）
    onRemote: null,                // 对方状态变化回调（页面刷新提示）
  };

  // 把 getConn() 的返回值统一规整为连接对象数组（分享端可能是数组，查看端是单对象）
  function toConns() {
    var r = getConn();
    if (!r) return [];
    if (Array.isArray(r)) return r;
    return [r];
  }

  // ---------- 数据通道发送控制消息（P2P，不经服务器） ----------
  v.send = function (obj) {
    var json = JSON.stringify(mergeVoice(obj));
    var conns = toConns();
    for (var i = 0; i < conns.length; i++) {
      var d = conns[i].dc;
      if (d && d.readyState === "open") {
        try { d.send(json); } catch (e) {}
      }
    }
  };

  // 组装控制消息（type 置顶，其余字段透传）
  function mergeVoice(obj) {
    var out = { type: "voice" };
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  // ---------- 计算"我当前是否在发送语音" ----------
  v.computeSpeaking = function () {
    if (!v.enabled || v.muted) return false;
    return v.mode === "ptt" ? v.pttHeld : v.contOn;
  };

  // 同步本地麦克风 track.enabled（不说话时静音，省流量）+ 上报对方"说话中"
  v.syncSpeaking = function () {
    var sp = v.computeSpeaking();
    if (v.stream) {
      for (var i = 0; i < v.stream.getAudioTracks().length; i++) {
        v.stream.getAudioTracks()[i].enabled = sp;
      }
    }
    if (sp !== v.sentSpeaking) {
      v.sentSpeaking = sp;
      v.send({ action: "speaking", v: sp });
    }
    if (v.onUi) v.onUi();
  };

  // ---------- 麦克风权限（必须由用户手势触发，https 环境） ----------
  v.getMicStream = function () {
    if (v.stream) return Promise.resolve(v.stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      v.micError = "当前浏览器不支持麦克风";
      return Promise.reject(new Error(v.micError));
    }
    var c = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };
    return navigator.mediaDevices.getUserMedia(c).then(function (stream) {
      v.stream = stream;
      v.micError = null;
      return stream;
    }, function (e) {
      v.micError = (e && e.name === "NotAllowedError")
        ? "麦克风权限被拒绝，请在浏览器地址栏允许后重试"
        : "无法获取麦克风";
      throw e;
    });
  };

  // ---------- 开启一次 offer/answer 协商（经 Ably 信令） ----------
  // conn = { pc, signaling, id? }；id 不传时回退到 v.friendId（查看端）
  v.renegotiate = function (conn) {
    if (!conn || !conn.pc || !conn.signaling) return Promise.resolve();
    v.renegotiating = true;
    return conn.pc.createOffer().then(function (offer) {
      return conn.pc.setLocalDescription(offer);
    }).then(function () {
      // 必须携带 id(=friendId)，安卓端才认得出该 offer 来自哪位好友并正确路由
      var msg = { type: "offer", sdp: conn.pc.localDescription };
      var id = (conn && conn.id) || v.friendId;
      if (id) msg.id = id;
      conn.signaling.send(msg);
    }).then(function () {
      v.renegotiating = false;
    }, function (e) {
      v.renegotiating = false;
      throw e;
    });
  };

  // ---------- 开启语音：采集 → 给每条连接 addTrack → 各自重协商 ----------
  v.enable = function () {
    var conns = toConns().filter(function (s) { return s.pc && s.signaling; });
    if (!conns.length) return Promise.resolve();
    return v.getMicStream().then(function (stream) {
      var tracks = stream.getAudioTracks();
      var jobs = [];
      // 给每条连接加上本条音频轨，并对每条连接各自发起一次重协商
      for (var ci = 0; ci < conns.length; ci++) {
        var s = conns[ci];
        // 防止 negotiateSoon(relay 的网络事件)与手动 createOffer 并发
        if (s.pc._voiceAddBusy) continue;
        for (var i = 0; i < tracks.length; i++) {
          var added = false;
          if (s.pc.getSenders) {
            var sns = s.pc.getSenders();
            for (var j = 0; j < sns.length; j++) {
              if (sns[j].track === tracks[i]) { added = true; break; }
            }
          }
          if (!added) { try { s.pc.addTrack(tracks[i], stream); } catch (e) {} }
        }
        s.pc._voiceAddBusy = true;
        (function (conn) {
          jobs.push(v.renegotiate(conn).then(function () {
            if (conn.pc) conn.pc._voiceAddBusy = false; // 完成后释放该连接的 busy 锁
          }).catch(function () {
            if (conn.pc) conn.pc._voiceAddBusy = false;
          }));
        })(s);
      }
      v.enabled = true;
      v.contOn = v.mode === "continuous";   // 免提模式：开启即说话
      v.syncSpeaking();
      return Promise.all(jobs).then(function () {
        if (v.onUi) v.onUi();
      });
    }, function (e) {
      v.enabled = false;
      if (v.onUi) v.onUi();
      throw e;
    });
  };

  // ---------- 关闭语音：停麦克风 + 移除所有连接上的轨道 + 各自重协商 ----------
  v.disable = function () {
    v.enabled = false;
    v.pttHeld = false;
    v.contOn = false;
    v.sentSpeaking = null;
    v.send({ action: "bye" });
    if (v.stream) {
      var trs = v.stream.getAudioTracks();
      for (var t = 0; t < trs.length; t++) trs[t].stop();
      try { v.stream.getTracks().forEach(function (x) { v.stream.removeTrack(x); }); } catch (e) {}
      v.stream = null;
    }
    var conns = toConns();
    var jobs = [];
    for (var ci = 0; ci < conns.length; ci++) {
      var s = conns[ci];
      if (!s.pc) { jobs.push(Promise.resolve()); continue; }
      try {
        s.pc.getSenders().forEach(function (snd) {
          if (snd.track && snd.track.kind === "audio") { try { s.pc.removeTrack(snd); } catch (e) {} }
        });
      } catch (e) {}
      if (s.signaling && !v.renegotiating) {
        (function (conn) {
          jobs.push(v.renegotiate(conn).then(function () {
            if (conn.pc) conn.pc._voiceAddBusy = false;
          }).catch(function () {
            if (conn.pc) conn.pc._voiceAddBusy = false;
          }));
        })(s);
      } else {
        if (s.pc) s.pc._voiceAddBusy = false;
        jobs.push(Promise.resolve());
      }
    }
    return Promise.all(jobs).then(function () {
      if (v.onUi) v.onUi();
    });
  };

  // ---------- 按键说话：按住/松开 ----------
  v.setPtt = function (held) {
    v.pttHeld = !!held;
    v.syncSpeaking();
  };

  // ---------- 免提持续：开/关 ----------
  v.toggleContinuous = function () {
    v.contOn = !v.contOn;
    v.syncSpeaking();
  };

  // ---------- 本机静音/取消 ----------
  v.toggleMute = function () {
    v.muted = !v.muted;
    if (v.muted) v.sentSpeaking = null;      // 静音后不再上报"说话中"
    v.syncSpeaking();
    v.send({ action: "mute", v: v.muted });
    if (v.onUi) v.onUi();
  };

  // ---------- 切换模式（按键 <-> 免提） ----------
  v.setMode = function (m) {
    if (m !== "ptt" && m !== "continuous") return;
    v.mode = m;
    v.pttHeld = false;
    v.contOn = m === "continuous";           // 切到免提=开始说话；切到按键=待命
    v.syncSpeaking();
    if (v.onUi) v.onUi();
  };

  // ---------- 接收对方控制消息 ----------
  v.handleControl = function (m) {
    if (!m) return;
    if (m.action === "speaking") v.remoteTalking = !!m.v;
    else if (m.action === "mute") v.remoteMuted = !!m.v;
    else if (m.action === "bye") { v.remoteTalking = false; v.remoteMuted = false; }
    if (v.onRemote) v.onRemote();
  };

  // ---------- 处理远端音频轨道（放到 pc.ontrack） ----------
  v.handleRemoteTrack = function (event) {
    if (!event || !event.track) return;
    var stream = event.streams && event.streams[0];
    if (!stream) stream = new MediaStream([event.track]);
    if (!v.remoteAudio) {
      v.remoteAudio = new Audio();
      v.remoteAudio.autoplay = true;
      v.remoteAudio.playsInline = true;
      v.remoteAudio.style.display = "none";
      document.body.appendChild(v.remoteAudio);
    }
    v.remoteAudio.srcObject = stream;
    v.remoteAudio.volume = 1;
    v.remoteAudio.play().catch(function () {});
    if (v.onRemote) v.onRemote();
  };

  // ---------- 远端音频不可用/断连时清理 ----------
  v.stopRemoteAudio = function () {
    if (v.remoteAudio) {
      try { v.remoteAudio.pause(); v.remoteAudio.srcObject = null; } catch (e) {}
    }
    v.remoteTalking = false;
    v.remoteMuted = false;
    if (v.onRemote) v.onRemote();
  };

  // ---------- 在用户手势里激活远端音频 ----------
  // 浏览器会拦截非用户手势的自动播放（带声音）——拿到麦克风/点按对讲键本身也是用户手势，
  // 这里顺带 resume 远端音频，保证"听到对方声音"不再被自动播放策略拦下。
  v.resumePlayback = function () {
    if (v.remoteAudio) {
      try { v.remoteAudio.play().catch(function () {}); } catch (e) {}
    }
  };

  // ---------- 退出/断连整体回收 ----------
  v.reset = function () {
    v.stopRemoteAudio();
    if (v.stream) {
      var trs = v.stream.getAudioTracks();
      for (var i = 0; i < trs.length; i++) trs[i].stop();
      try { v.stream.getTracks().forEach(function (x) { v.stream.removeTrack(x); }); } catch (e) {}
      v.stream = null;
    }
    v.enabled = false;
    v.pttHeld = false;
    v.contOn = false;
    v.muted = false;
    v.remoteTalking = false;
    v.remoteMuted = false;
    v.sentSpeaking = null;
    if (v.onUi) v.onUi();
    if (v.onRemote) v.onRemote();
  };

  return v;
}

// ============================================================
//  语音重协商应答
//  连接已建立且处于 stable 时，直接在同一 pc 上应答新的 offer
//  （语音重协商）。否则返回 false，由调用方走原有"新建连接"逻辑。
//  send 由调用方提供（保持各页信令一致）。
// ============================================================
function answerVoiceRenegotiation(voice, pc, signaling, sdp, send) {
  if (pc && pc.connectionState === "connected" && pc.signalingState === "stable") {
    return pc.setRemoteDescription(sdp).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer);
    }).then(function () {
      send({ type: "answer", sdp: pc.localDescription });
      return true;
    }).catch(function () { return false; });
  }
  return Promise.resolve(false);
}

// ============================================================
//  绑定页面对讲 UI
//  依赖页面元素：voiceBtn / voiceTip / voicePanel / vStatus /
//  vClose / voiceSeg / vCont / vMute / vRemote / vDisable
// ============================================================
function bindVoiceUI(v) {
  var btn = document.getElementById("voiceBtn");
  var tip = document.getElementById("voiceTip");
  var panel = document.getElementById("voicePanel");
  var status = document.getElementById("vStatus");
  var seg = document.getElementById("voiceSeg");
  var cont = document.getElementById("vCont");
  var mute = document.getElementById("vMute");
  var remote = document.getElementById("vRemote");
  var close = document.getElementById("vClose");
  var disable = document.getElementById("vDisable");
  if (!btn || !panel) return;

  panel._open = false;

  function render() {
    var talking = v.computeSpeaking();
    // 与安卓一致：仅"说话中"变绿，其余（含开启待命）保持深浅自适应底 + 紫图标
    btn.classList.toggle("hold", talking);
    // 状态胶囊
    if (!v.enabled) status.textContent = v.micError ? "麦克风不可用" : "语音关闭";
    else if (v.muted) status.textContent = "已静音";
    else if (talking) status.textContent = "说话中";
    else status.textContent = "待命";
    // 模式
    if (seg) seg.querySelectorAll("[data-md]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-md") === v.mode);
    });
    // 免提持续开关（仅免提模式显示）
    if (cont) {
      cont.classList.toggle("on", v.contOn);
      cont.style.display = v.mode === "continuous" ? "" : "none";
    }
    // 静音
    if (mute) mute.classList.toggle("on", v.muted);
    panel.classList.toggle("show", !!panel._open);
  }

  function renderRemote() {
    if (tip) {
      if (v.remoteMuted) { tip.textContent = "对方已静音"; tip.classList.add("show"); }
      else if (v.remoteTalking) { tip.textContent = "对方 · 说话中"; tip.classList.add("show"); }
      else tip.classList.remove("show");
    }
    if (remote) {
      remote.textContent = v.remoteMuted ? "对方已静音"
        : v.remoteTalking ? "对方 · 说话中" : "对方 · 未说话";
    }
    render();
  }

  v.onUi = render;
  v.onRemote = renderRemote;

  function openPanel(open) {
    panel._open = open !== undefined ? !!open : !panel._open;
    render();
  }

  // 长按 = 按键说话；松开即停（与手机端一致）。
  // 注意：长按松手后浏览器仍会派发一个 click，若不区分，会把模式误切到「免提持续」而一直说话，
  // 表现为「松手不关闭」。这里用按住时长阈值区分长按与单击：长按松手 → 抑制随后的 click。
  var HOLD_MS = 350;
  var holding = false;
  var longPressed = false;   // 本次按压是否属于长按（按住超过阈值）
  var holdTimer = null;
  btn.addEventListener("pointerdown", function (e) {
    v.resumePlayback();   // 用户手势：顺带激活远端音频播放（绕过自动播放拦截）
    holding = true;
    longPressed = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (v.enabled && v.mode === "ptt") {
      if (e.preventDefault) e.preventDefault();
      v.setPtt(true);   // 立即说话
    }
    // 按住超过阈值仍没松手 → 判定为长按（只有真正在「按住说话」才算）
    holdTimer = setTimeout(function () {
      if (holding && v.enabled && v.mode === "ptt") longPressed = true;
    }, HOLD_MS);
  });
  var release = function () {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!holding) return;
    holding = false;
    if (v.enabled && v.mode === "ptt") v.setPtt(false);   // 松手即停
    if (longPressed) { longPressed = false; btn._suppressClick = true; }   // 抑制随后 click 的换模式
  };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("pointercancel", release);

  // 单击：未开启 → 开启语音（默认按键模式）；已开启 → 切换 按键/免提持续 模式。
  // 不再弹设置浮层，与手机端交互一致：长按=说话、单击=切换持续说话。
  btn.addEventListener("click", function () {
    if (btn._suppressClick) { btn._suppressClick = false; return; }   // 长按松手 → 忽略本次单击
    v.resumePlayback();   // 用户手势：顺带激活远端音频播放
    if (!v.enabled) {
      v.enable().then(function () { render(); }).catch(function () { render(); });
      return;
    }
    v.setMode(v.mode === "ptt" ? "continuous" : "ptt");
  });

  // 模式切换
  if (seg) seg.addEventListener("click", function (e) {
    var b = e.target.closest("[data-md]");
    if (!b) return;
    v.setMode(b.getAttribute("data-md"));
  });
  // 免提持续开关
  if (cont) cont.addEventListener("click", function () { v.toggleContinuous(); });
  // 静音开关
  if (mute) mute.addEventListener("click", function () { v.toggleMute(); });
  // 关闭浮层
  if (close) close.addEventListener("click", function () { openPanel(false); });
  // 关闭语音
  if (disable) disable.addEventListener("click", function () {
    v.disable().then(function () { openPanel(false); });
  });

  render();
  renderRemote();
}