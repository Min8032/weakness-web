(function () {
  "use strict";

  const STORAGE = "weakness_web_v1";
  const TIMER_MINUTES = [0, 30, 60, 90, 120, 150, 180, 210, 240];
  const MODES = [
    { id: "order", label: "顺序" },
    { id: "repeat", label: "单曲" },
    { id: "shuffle", label: "随机" },
  ];

  const audio = document.getElementById("audio");
  const listEl = document.getElementById("chapterList");
  const subtitle = document.getElementById("subtitle");
  const nowPlaying = document.getElementById("nowPlaying");
  const seekBar = document.getElementById("seekBar");
  const timeCurrent = document.getElementById("timeCurrent");
  const timeDuration = document.getElementById("timeDuration");
  const btnPlay = document.getElementById("btnPlay");
  const btnPrev = document.getElementById("btnPrev");
  const btnNext = document.getElementById("btnNext");
  const btnMute = document.getElementById("btnMute");
  const btnTimer = document.getElementById("btnTimer");
  const btnMode = document.getElementById("btnMode");
  const modeLabel = document.getElementById("modeLabel");
  const timerMenu = document.getElementById("timerMenu");
  const timerOptions = document.getElementById("timerOptions");
  const timerClose = document.getElementById("timerClose");

  let chapters = [];
  let index = 0;
  let userSeeking = false;
  let playMode = "order";
  let muted = false;
  let sleepTimerEndMs = 0;
  let sleepTimerMinutes = 0;
  let saveTimer = null;
  let uiTimer = null;
  let sleepCheckTimer = null;
  let loadedFile = "";
  let audioLoading = false;
  let pendingResumePos = 0;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return {};
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }

  function saveState() {
    const data = {
      index,
      pos: Math.floor(audio.currentTime || 0),
      wasPlaying: !audio.paused && !audioLoading,
      playMode,
      muted,
      sleepTimerEndMs,
      sleepTimerMinutes,
    };
    localStorage.setItem(STORAGE, JSON.stringify(data));
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function remainingTimerMinutes() {
    if (sleepTimerEndMs <= 0) return 0;
    const rem = sleepTimerEndMs - Date.now();
    if (rem <= 0) return 0;
    return Math.ceil(rem / 60000);
  }

  function getSelectedTimerMinutes() {
    if (remainingTimerMinutes() <= 0) return 0;
    return sleepTimerMinutes;
  }

  function setSleepTimer(minutes) {
    if (minutes <= 0) {
      sleepTimerEndMs = 0;
      sleepTimerMinutes = 0;
    } else {
      sleepTimerMinutes = minutes;
      sleepTimerEndMs = Date.now() + minutes * 60 * 1000;
    }
    updateTimerUi();
    scheduleSave();
    restartSleepCheck();
  }

  function restartSleepCheck() {
    if (sleepCheckTimer) clearInterval(sleepCheckTimer);
    sleepCheckTimer = null;
    if (sleepTimerEndMs <= 0) return;
    sleepCheckTimer = setInterval(function () {
      if (sleepTimerEndMs > 0 && Date.now() >= sleepTimerEndMs) {
        sleepTimerEndMs = 0;
        sleepTimerMinutes = 0;
        audio.pause();
        updatePlayUi();
        updateTimerUi();
        scheduleSave();
        clearInterval(sleepCheckTimer);
        sleepCheckTimer = null;
      }
    }, 1000);
  }

  function updateTimerUi() {
    const rem = remainingTimerMinutes();
    if (rem > 0) {
      btnTimer.classList.add("active");
      btnTimer.title = "定时剩余 " + rem + " 分钟";
    } else {
      btnTimer.classList.remove("active");
      btnTimer.title = "定时停止";
    }
  }

  function updateMuteUi() {
    audio.muted = muted;
    btnMute.textContent = muted ? "🔇" : "🔊";
    btnMute.title = muted ? "已静音" : "取消静音";
  }

  function updateModeUi() {
    const m = MODES.find(function (x) { return x.id === playMode; }) || MODES[0];
    modeLabel.textContent = m.label;
  }

  function updatePlayUi() {
    btnPlay.textContent = audio.paused ? "▶" : "⏸";
    btnPlay.setAttribute("aria-label", audio.paused ? "播放" : "暂停");
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !chapters[index]) return;
    const c = chapters[index];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: c.title,
      artist: "人性的弱点",
      album: c.part,
    });
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }

  function renderList() {
    listEl.innerHTML = "";
    let lastPart = null;
    chapters.forEach(function (c, i) {
      if (c.part !== lastPart) {
        const h = document.createElement("li");
        h.className = "header";
        h.textContent = c.part;
        listEl.appendChild(h);
        lastPart = c.part;
      }
      const li = document.createElement("li");
      li.className = "item" + (i === index ? " current" : "");
      li.dataset.index = String(i);
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = i === index && !audio.paused ? "▶" : "";
      const title = document.createElement("span");
      title.textContent = c.title;
      li.appendChild(mark);
      li.appendChild(title);
      li.addEventListener("click", function () {
        playIndex(i, 0, true);
      });
      listEl.appendChild(li);
    });
  }

  function scrollToCurrent() {
    const cur = listEl.querySelector("li.item.current");
    if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function setNowPlayingTitle(c, suffix) {
    nowPlaying.textContent = c.title + (suffix || "");
  }

  function applySeekAndPlay(posSec, autoplay) {
    if (posSec > 0 && audio.duration && posSec < audio.duration - 1) {
      audio.currentTime = posSec;
    }
    if (autoplay) {
      audio.play().catch(function () { updatePlayUi(); });
    } else {
      updatePlayUi();
    }
    renderList();
    updateMediaSession();
    scheduleSave();
  }

  /** 只更新列表与标题，不请求音频文件 */
  function showChapterUi(i) {
    if (i < 0 || i >= chapters.length) return;
    index = i;
    const c = chapters[i];
    setNowPlayingTitle(c);
    renderList();
    updateMediaSession();
    updatePlayUi();
  }

  /** 按需加载单集音频（进入页面后再加载，不预载其它集） */
  function loadChapterAudio(i, posSec, autoplay) {
    if (i < 0 || i >= chapters.length) return;
    index = i;
    const c = chapters[i];
    if (loadedFile === c.file && audio.src) {
      setNowPlayingTitle(c);
      applySeekAndPlay(posSec, autoplay);
      return;
    }
    loadedFile = c.file;
    audioLoading = true;
    setNowPlayingTitle(c, " · 加载中…");
    updatePlayUi();
    audio.src = "audio/" + encodeURIComponent(c.file);
    audio.load();
    const start = function () {
      audioLoading = false;
      setNowPlayingTitle(c);
      applySeekAndPlay(posSec, autoplay);
    };
    if (audio.readyState >= 1) start();
    else audio.addEventListener("loadedmetadata", start, { once: true });
  }

  function playIndex(i, posSec, autoplay) {
    if (i !== index) pendingResumePos = 0;
    loadChapterAudio(i, posSec, autoplay);
  }

  function toggle() {
    if (!audio.src || loadedFile !== chapters[index].file) {
      const pos = pendingResumePos > 0 ? pendingResumePos : audio.currentTime || 0;
      pendingResumePos = 0;
      loadChapterAudio(index, pos, true);
      return;
    }
    if (audio.paused) {
      audio.play().catch(function () {});
    } else {
      audio.pause();
    }
  }

  function pickShuffleIndex(current) {
    if (chapters.length <= 1) return current;
    let next;
    do {
      next = Math.floor(Math.random() * chapters.length);
    } while (next === current);
    return next;
  }

  function nextTrack() {
    if (playMode === "repeat") {
      playIndex(index, 0, true);
      return;
    }
    if (playMode === "shuffle") {
      playIndex(pickShuffleIndex(index), 0, true);
      return;
    }
    if (index + 1 < chapters.length) playIndex(index + 1, 0, true);
  }

  function prevTrack() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      scheduleSave();
      return;
    }
    if (playMode === "shuffle") {
      playIndex(pickShuffleIndex(index), 0, true);
      return;
    }
    if (index - 1 >= 0) playIndex(index - 1, 0, true);
  }

  function onEnded() {
    if (playMode === "repeat") {
      playIndex(index, 0, true);
      return;
    }
    if (playMode === "shuffle") {
      playIndex(pickShuffleIndex(index), 0, true);
      return;
    }
    if (index + 1 < chapters.length) playIndex(index + 1, 0, true);
    else audio.pause();
  }

  function cycleMode() {
    const idx = MODES.findIndex(function (m) { return m.id === playMode; });
    playMode = MODES[(idx + 1) % MODES.length].id;
    updateModeUi();
    scheduleSave();
  }

  function buildTimerMenu() {
    timerOptions.innerHTML = "";
    const selected = getSelectedTimerMinutes();
    const remMin = remainingTimerMinutes();

    TIMER_MINUTES.forEach(function (min, order) {
      const li = document.createElement("li");
      const isSelected = min === 0 ? selected === 0 : selected === min && remMin > 0;
      if (isSelected) li.classList.add("selected");

      const radio = document.createElement("span");
      radio.className = "radio";
      const label = document.createElement("span");
      label.className = "label";
      if (min === 0) {
        label.textContent = "关闭定时";
      } else {
        label.textContent = min + "分钟";
      }
      const extra = document.createElement("span");
      if (isSelected && min > 0 && remMin > 0) {
        extra.textContent = "剩余" + remMin + "分钟";
        extra.style.color = "var(--accent)";
        extra.style.fontSize = "13px";
      }
      li.appendChild(radio);
      li.appendChild(label);
      li.appendChild(extra);
      li.addEventListener("click", function () {
        setSleepTimer(min);
        timerMenu.classList.add("hidden");
      });
      timerOptions.appendChild(li);
    });
  }

  function bindEvents() {
    btnPlay.addEventListener("click", toggle);
    btnPrev.addEventListener("click", prevTrack);
    btnNext.addEventListener("click", nextTrack);
    btnMode.addEventListener("click", cycleMode);
    modeLabel.addEventListener("click", cycleMode);
    btnMute.addEventListener("click", function () {
      muted = !muted;
      updateMuteUi();
      scheduleSave();
    });
    btnTimer.addEventListener("click", function () {
      buildTimerMenu();
      timerMenu.classList.remove("hidden");
    });
    timerClose.addEventListener("click", function () {
      timerMenu.classList.add("hidden");
    });
    timerMenu.addEventListener("click", function (e) {
      if (e.target === timerMenu) timerMenu.classList.add("hidden");
    });

    seekBar.addEventListener("input", function () {
      userSeeking = true;
      timeCurrent.textContent = fmt(seekBar.value);
    });
    seekBar.addEventListener("change", function () {
      userSeeking = false;
      audio.currentTime = Number(seekBar.value);
      scheduleSave();
    });

    audio.addEventListener("timeupdate", function () {
      if (!userSeeking && audio.duration) {
        seekBar.max = String(Math.floor(audio.duration));
        seekBar.value = String(Math.floor(audio.currentTime));
        timeCurrent.textContent = fmt(audio.currentTime);
      }
      scheduleSave();
    });
    audio.addEventListener("loadedmetadata", function () {
      seekBar.max = String(Math.floor(audio.duration || 0));
      timeDuration.textContent = fmt(audio.duration || 0);
    });
    audio.addEventListener("play", function () {
      updatePlayUi();
      renderList();
      updateMediaSession();
    });
    audio.addEventListener("pause", function () {
      updatePlayUi();
      renderList();
      updateMediaSession();
      scheduleSave();
    });
    audio.addEventListener("ended", onEnded);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", function () { audio.play(); });
      navigator.mediaSession.setActionHandler("pause", function () { audio.pause(); });
      navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
      navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
    }
  }

  function startUiLoop() {
    if (uiTimer) clearInterval(uiTimer);
    uiTimer = setInterval(function () {
      updateTimerUi();
    }, 1000);
  }

  fetch("chapters.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      chapters = data;
      subtitle.textContent = "有声书 · 全 " + chapters.length + " 集";

      const st = loadState();
      index = Math.min(st.index || 0, chapters.length - 1);
      playMode = st.playMode || "order";
      muted = !!st.muted;
      sleepTimerEndMs = st.sleepTimerEndMs || 0;
      sleepTimerMinutes = st.sleepTimerMinutes || 0;
      if (remainingTimerMinutes() <= 0) {
        sleepTimerEndMs = 0;
        sleepTimerMinutes = 0;
      }

      bindEvents();
      updateModeUi();
      updateMuteUi();
      updateTimerUi();
      restartSleepCheck();
      startUiLoop();

      pendingResumePos = st.pos || 0;
      showChapterUi(index);
      if (pendingResumePos > 0 && chapters[index]) {
        setNowPlayingTitle(chapters[index], " · 点 ▶ 继续（" + fmt(pendingResumePos) + "）");
      }
      scrollToCurrent();
    })
    .catch(function () {
      subtitle.textContent = "加载失败，请通过 HTTP 服务器打开本页";
    });
})();
