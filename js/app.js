(function () {
  "use strict";

  const Engine = window.CS2Engine;
  const Flags = window.CS2Flags;
  const builtInPlayers = window.DEFAULT_PLAYERS;
  const STORAGE = { players:"fragle.players.v1", history:"fragle.history.v1", theme:"fragle.theme" };
  const PAGE_SIZE = 10;
  const stateLabels = {
    unset:"点击设置", exact:"绿色 · 正确", close:"黄色 · 同赛区", miss:"灰色 · 不匹配",
    "close-up":"黄色 · ↑", "close-down":"黄色 · ↓", "miss-up":"灰色 · ↑", "miss-down":"灰色 · ↓"
  };
  const optionLabels = {
    exact:"绿色 · 完全正确", close:"黄色 · 同赛区", miss:"灰色 · 不匹配",
    "close-up":"黄色 · 答案更大 ↑", "close-down":"黄色 · 答案更小 ↓",
    "miss-up":"灰色 · 答案更大 ↑", "miss-down":"灰色 · 答案更小 ↓"
  };
  const $ = function (selector) { return document.querySelector(selector); };
  const els = {
    form:$("#guessForm"), search:$("#playerSearch"), results:$("#searchResults"), list:$("#guessList"), empty:$("#guessEmpty"),
    candidateBody:$("#candidateBody"), candidateSearch:$("#candidateSearch"), candidateSort:$("#candidateSort"), noCandidates:$("#noCandidates"),
    filterRegion:$("#filterRegion"), filterTeam:$("#filterTeam"), filterCountry:$("#filterCountry"), filterRole:$("#filterRole"), filterStatus:$("#filterStatus"),
    filterAgeMin:$("#filterAgeMin"), filterAgeMax:$("#filterAgeMax"), filterMajorWinsMin:$("#filterMajorWinsMin"), filterMajorWinsMax:$("#filterMajorWinsMax"), filterMajorAppsMin:$("#filterMajorAppsMin"), filterMajorAppsMax:$("#filterMajorAppsMax"), clearFilters:$("#clearCandidateFilters"),
    summary:$("#candidateSummary"), pagination:$("#pagination"), recommendation:$("#recommendation"),
    heroGuesses:$("#heroGuesses"), roundDots:$("#roundDots"), sessionStatus:$("#sessionStatus"),
    undo:$("#undoBtn"), reset:$("#resetBtn"), toast:$("#toast"), dataCount:$("#dataCount")
  };

  let players = loadJson(STORAGE.players, builtInPlayers);
  let history = loadJson(STORAGE.history, []);
  let selectedPlayer = null;
  let searchIndex = -1;
  let page = 1;
  let toastTimer;
  let filterMenuIndex = -1;
  const filterConfigs = [
    { input:els.filterRegion, field:"region" }, { input:els.filterTeam, field:"team" }, { input:els.filterCountry, field:"country" },
    { input:els.filterRole, field:"role" }, { input:els.filterStatus, field:"status" }
  ];

  function loadJson(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value || fallback; }
    catch (_) { return fallback; }
  }
  function save() { localStorage.setItem(STORAGE.history, JSON.stringify(history)); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]; }); }
  function avatar(player) {
    return Flags.flag(player.country, "avatar");
  }
  function feedbackBlank() { return Engine.FIELD_ORDER.reduce(function (acc, field) { acc[field] = "unset"; return acc; }, {}); }
  function ownGuessCount() { return history.filter(function (entry) { return entry.source === "me"; }).length; }
  function showToast(message) { clearTimeout(toastTimer); els.toast.textContent = message; els.toast.classList.add("show"); toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 2200); }

  function findMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players.filter(function (p) { return p.id.toLowerCase().includes(q); }).slice(0, 8);
  }
  function renderSearch() {
    const matches = findMatches(els.search.value);
    selectedPlayer = matches.find(function (p) { return p.id.toLowerCase() === els.search.value.trim().toLowerCase(); }) || null;
    if (!matches.length) { els.results.classList.remove("open"); els.results.innerHTML = ""; return; }
    els.results.innerHTML = matches.map(function (p, i) {
      return '<button type="button" class="search-result ' + (i === searchIndex ? "active" : "") + '" data-id="' + escapeHtml(p.id) + '">' + avatar(p) + '<strong>' + escapeHtml(p.id) + '</strong><small>' + escapeHtml(p.team) + ' · ' + escapeHtml(p.country) + '</small></button>';
    }).join("");
    els.results.classList.add("open");
  }
  function choosePlayer(id) {
    selectedPlayer = players.find(function (p) { return p.id.toLowerCase() === id.toLowerCase(); }) || null;
    if (selectedPlayer) { els.search.value = selectedPlayer.id; els.results.classList.remove("open"); }
  }
  function addGuess(player, source) {
    if (history.some(function (entry) { return entry.player.id.toLowerCase() === player.id.toLowerCase(); })) { showToast("这名选手已经录入过了"); return; }
    if (source === "me" && ownGuessCount() >= 8) { showToast("本轮已经达到 8 次猜测上限"); return; }
    history.push({ player:Object.assign({}, player), source:source, feedback:feedbackBlank(), createdAt:Date.now() });
    save(); selectedPlayer = null; els.search.value = ""; page = 1; render();
    setTimeout(function () { const buttons = els.list.querySelectorAll(".feedback-btn"); if (buttons.length) buttons[buttons.length - 7].focus(); }, 30);
  }

  function feedbackValue(player, field) {
    if (field === "majorWins") return player[field] + " 冠";
    if (field === "majorApps") return player[field] + " 次";
    return player[field];
  }
  function renderHistory() {
    const previousCards = new Set(Array.from(els.list.querySelectorAll("[data-guess-key]"), function (card) { return card.dataset.guessKey; }));
    const previousStates = new Map(Array.from(els.list.querySelectorAll("[data-feedback-key]"), function (button) { return [button.dataset.feedbackKey, button.dataset.state]; }));
    els.empty.hidden = history.length > 0;
    els.list.innerHTML = history.map(function (entry, index) {
      const guessKey = entry.source + ":" + entry.player.id.toLowerCase();
      const cells = Engine.FIELD_ORDER.map(function (field) {
        const current = entry.feedback[field] || "unset";
        const feedbackKey = guessKey + ":" + field;
        const displayValue = field === "country" ? Flags.flag(entry.player.country, "feedback-flag") : escapeHtml(feedbackValue(entry.player, field));
        return '<div class="feedback-cell"><button class="feedback-btn" data-entry="' + index + '" data-field="' + field + '" data-feedback-key="' + escapeHtml(feedbackKey) + '" data-state="' + current + '" aria-label="' + escapeHtml(Engine.FIELD_META[field].label + "：" + feedbackValue(entry.player, field) + "，" + stateLabels[current]) + '"><span class="field">' + Engine.FIELD_META[field].label + '</span><span class="value">' + displayValue + '</span><span class="state">' + stateLabels[current] + '</span></button></div>';
      }).join("");
      return '<div class="guess-card" data-guess-key="' + escapeHtml(guessKey) + '"><div class="guess-card-head"><small>#' + String(index + 1).padStart(2,"0") + '</small>' + avatar(entry.player) + '<strong>' + escapeHtml(entry.player.id) + '</strong><span class="source-badge ' + entry.source + '">' + (entry.source === "me" ? "我的猜测" : "对手公开") + '</span><button class="remove" data-remove="' + index + '" title="删除">×</button></div><div class="feedback-grid">' + cells + '</div></div>';
    }).join("");
    els.list.querySelectorAll("[data-guess-key]").forEach(function (card) { if (!previousCards.has(card.dataset.guessKey)) card.classList.add("guess-card-enter"); });
    els.list.querySelectorAll("[data-feedback-key]").forEach(function (button) { const before = previousStates.get(button.dataset.feedbackKey); if (before && before !== button.dataset.state) button.classList.add("feedback-btn-change"); });
  }
  function openFeedbackMenu(button) {
    document.querySelectorAll(".feedback-menu").forEach(function (menu) { menu.remove(); });
    const field = button.dataset.field;
    const menu = document.createElement("div"); menu.className = "feedback-menu";
    menu.innerHTML = Engine.allowedStates(field).map(function (value) { return '<button class="feedback-option feedback-option-' + value + '" data-feedback="' + value + '"><i class="feedback-swatch" aria-hidden="true"></i><span>' + optionLabels[value] + '</span></button>'; }).join("") + '<button class="feedback-option feedback-option-unset" data-feedback="unset"><i class="feedback-swatch" aria-hidden="true"></i><span>清除设置</span></button>';
    button.parentNode.appendChild(menu);
    menu.querySelectorAll("button").forEach(function (option) {
      option.addEventListener("click", function (event) {
        event.stopPropagation(); history[Number(button.dataset.entry)].feedback[field] = option.dataset.feedback; save(); render();
      });
    });
  }

  function sortedValues(field) {
    return Array.from(new Set(players.map(function (player) { return String(player[field] || "").trim(); }).filter(Boolean))).sort(function (a,b) { return a.localeCompare(b,"zh-CN"); });
  }
  function populateCandidateFilters() {
    filterConfigs.forEach(function (config) { config.values = sortedValues(config.field); });
  }
  function closeFilterMenus(except) {
    document.querySelectorAll(".filter-combobox.open").forEach(function (combo) { if (combo !== except) combo.classList.remove("open"); });
  }
  function renderFilterMenu(input, open) {
    const config = filterConfigs.find(function (item) { return item.input === input; });
    const combo = input.closest(".filter-combobox"), options = combo.querySelector(".filter-options");
    const query = input.value.trim().toLowerCase();
    const values = (config?.values || []).filter(function (value) { return !query || value.toLowerCase().includes(query); }).slice(0,80);
    options.innerHTML = values.length ? values.map(function (value) {
      return '<button type="button" role="option" data-filter-value="' + escapeHtml(value) + '" class="' + (value === input.value ? "selected" : "") + '">' + escapeHtml(value) + '</button>';
    }).join("") : '<span class="filter-no-options">没有匹配项，可继续用当前文字筛选</span>';
    filterMenuIndex = -1;
    closeFilterMenus(combo);
    combo.classList.toggle("open", Boolean(open));
  }
  function chooseFilterValue(input, value) {
    input.value = value;
    input.closest(".filter-combobox").classList.remove("open");
    page = 1;
    render();
  }
  function bindCandidateFilter(config) {
    const input = config.input, combo = input.closest(".filter-combobox");
    const toggle = combo.querySelector(".filter-toggle"), options = combo.querySelector(".filter-options");
    input.addEventListener("focus", function () { renderFilterMenu(input, true); });
    input.addEventListener("input", function () { renderFilterMenu(input, true); });
    toggle.addEventListener("click", function (event) {
      event.preventDefault(); event.stopPropagation();
      const shouldOpen = !combo.classList.contains("open");
      if (shouldOpen) { input.focus(); renderFilterMenu(input, true); } else combo.classList.remove("open");
    });
    options.addEventListener("click", function (event) {
      const button = event.target.closest("[data-filter-value]");
      if (button) chooseFilterValue(input, button.dataset.filterValue);
    });
    input.addEventListener("keydown", function (event) {
      const buttons = Array.from(options.querySelectorAll("[data-filter-value]"));
      if (event.key === "Escape") { combo.classList.remove("open"); input.blur(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!combo.classList.contains("open")) renderFilterMenu(input, true);
        filterMenuIndex = event.key === "ArrowDown" ? Math.min(filterMenuIndex + 1, buttons.length - 1) : Math.max(filterMenuIndex - 1, 0);
        buttons.forEach(function (button,index) { button.classList.toggle("active", index === filterMenuIndex); });
      }
      if (event.key === "Enter" && buttons[filterMenuIndex]) { event.preventDefault(); chooseFilterValue(input, buttons[filterMenuIndex].dataset.filterValue); }
    });
  }
  function optionalNumber(input) {
    if (input.value.trim() === "") return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }
  function applyCandidateFilters(candidates) {
    const query = els.candidateSearch.value.trim().toLowerCase();
    const ageMin = optionalNumber(els.filterAgeMin), ageMax = optionalNumber(els.filterAgeMax);
    const majorWinsMin = optionalNumber(els.filterMajorWinsMin), majorWinsMax = optionalNumber(els.filterMajorWinsMax);
    const majorAppsMin = optionalNumber(els.filterMajorAppsMin), majorAppsMax = optionalNumber(els.filterMajorAppsMax);
    return candidates.filter(function (player) {
      if (query && ![player.id,player.team,player.country,player.region,player.role,player.status].some(function (value) { return String(value || "").toLowerCase().includes(query); })) return false;
      if (els.filterRegion.value && !String(player.region || "").toLowerCase().includes(els.filterRegion.value.trim().toLowerCase())) return false;
      if (els.filterTeam.value && !String(player.team || "").toLowerCase().includes(els.filterTeam.value.trim().toLowerCase())) return false;
      if (els.filterCountry.value && !String(player.country || "").toLowerCase().includes(els.filterCountry.value.trim().toLowerCase())) return false;
      if (els.filterRole.value && !String(player.role || "").toLowerCase().includes(els.filterRole.value.trim().toLowerCase())) return false;
      if (els.filterStatus.value && !String(player.status || "").toLowerCase().includes(els.filterStatus.value.trim().toLowerCase())) return false;
      if (ageMin !== null && Number(player.age) < ageMin) return false;
      if (ageMax !== null && Number(player.age) > ageMax) return false;
      if (majorWinsMin !== null && Number(player.majorWins) < majorWinsMin) return false;
      if (majorWinsMax !== null && Number(player.majorWins) > majorWinsMax) return false;
      if (majorAppsMin !== null && Number(player.majorApps) < majorAppsMin) return false;
      if (majorAppsMax !== null && Number(player.majorApps) > majorAppsMax) return false;
      return true;
    });
  }
  function currentCandidates() { return applyCandidateFilters(Engine.filterCandidates(players, history)); }
  function renderCandidates(candidates, rankings) {
    let shown = candidates.slice();
    const scoreMap = new Map(rankings.map(function (r) { return [r.player.id.toLowerCase(), r.entropy]; }));
    if (els.candidateSort.value === "name") shown.sort(function (a,b) { return a.id.localeCompare(b.id); });
    else if (els.candidateSort.value === "age") shown.sort(function (a,b) { return a.age - b.age || a.id.localeCompare(b.id); });
    else shown.sort(function (a,b) { return (scoreMap.get(b.id.toLowerCase()) || 0) - (scoreMap.get(a.id.toLowerCase()) || 0); });
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE)); page = Math.min(page, pages);
    const rows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    els.candidateBody.innerHTML = rows.map(function (p) {
      return '<tr><td><div class="player-cell">' + avatar(p) + '<div><strong>' + escapeHtml(p.id) + '</strong><small>' + escapeHtml(p.status) + '</small></div></div></td><td>' + escapeHtml(p.team) + '</td><td>' + escapeHtml(p.country) + '<br><span class="region">' + escapeHtml(p.region) + '</span></td><td>' + p.age + '</td><td>' + escapeHtml(p.role) + '</td><td>' + p.majorWins + ' 冠 / ' + p.majorApps + ' 次</td><td class="' + (p.status === "现役" ? "active" : "") + '">' + escapeHtml(p.status) + '</td><td><button class="use-player" data-use="' + escapeHtml(p.id) + '" title="用作下一猜">＋</button></td></tr>';
    }).join("");
    els.noCandidates.hidden = shown.length !== 0; els.candidateBody.parentElement.hidden = shown.length === 0;
    els.summary.textContent = "共 " + shown.length + " 位候选 · 第 " + page + " / " + pages + " 页";
    els.pagination.innerHTML = Array.from({length:pages}, function (_, i) { const n=i+1; return '<button data-page="' + n + '" class="' + (n===page?"active":"") + '">' + n + '</button>'; }).slice(0,8).join("");
  }

  function renderRecommendation(candidates, rankings) {
    if (!candidates.length || !rankings.length) { els.recommendation.innerHTML = '<div class="rec-empty">没有可推荐的选手。请先修正互相冲突的反馈。</div>'; return; }
    if (candidates.length === 1) {
      const p = candidates[0];
      els.recommendation.innerHTML = '<div class="rec-main"><div class="rec-player">' + avatar(p) + '<div><h3>' + escapeHtml(p.id) + '</h3><p>' + escapeHtml(p.team) + ' · ' + escapeHtml(p.country) + '</p></div><div class="info-score"><strong>唯一</strong><small>剩余答案</small></div></div><p class="rec-reason">所有已录入反馈都指向这名选手，可以直接尝试。</p><button class="primary-btn" style="width:100%;height:42px" data-use="' + escapeHtml(p.id) + '">设为下一猜 →</button></div>'; return;
    }
    const rec = rankings[0], p = rec.player;
    const distinctTeams = new Set(candidates.map(function (x) { return x.team; })).size;
    const distinctRegions = new Set(candidates.map(function (x) { return x.region; })).size;
    els.recommendation.innerHTML = '<div class="rec-main"><div class="rec-player">' + avatar(p) + '<div><h3>' + escapeHtml(p.id) + '</h3><p>' + escapeHtml(p.team) + ' · ' + escapeHtml(p.country) + '</p></div><div class="info-score"><strong>' + rec.score + '%</strong><small>信息效率</small></div></div><p class="rec-reason">这次猜测预计能把剩余答案分成最多的不同反馈组合。' + (rec.possible ? "他同时也是可能答案。" : "即使他不是候选，也能提供更强的排除信息。") + '</p><div class="rec-stats"><div><strong>' + candidates.length + '</strong><span>剩余候选</span></div><div><strong>' + distinctTeams + '</strong><span>不同队伍</span></div><div><strong>' + distinctRegions + '</strong><span>不同赛区</span></div></div><button class="primary-btn" style="width:100%;height:42px" data-use="' + escapeHtml(p.id) + '">设为下一猜 →</button></div>';
  }
  function renderProgress(candidateCount) {
    const own = ownGuessCount(); els.heroGuesses.textContent = own;

    els.roundDots.innerHTML = Array.from({length:8}, function (_,i) { return '<i class="' + (i < own ? "done" : "") + '"></i>'; }).join("");
    els.sessionStatus.textContent = !history.length ? "等待开始" : own >= 8 ? "已到猜测上限" : "推理中 · 还剩 " + (8-own) + " 次";
    els.undo.disabled = !history.length; els.reset.disabled = !history.length; els.dataCount.textContent = players.length;
  }
  function render() {
    const candidates = currentCandidates(); const rankings = Engine.rankGuesses(players, candidates, history);
    renderHistory(); renderCandidates(candidates, rankings); renderRecommendation(candidates, rankings); renderProgress(candidates.length);
  }

  els.search.addEventListener("input", function () { searchIndex=-1; renderSearch(); });
  els.search.addEventListener("keydown", function (event) {
    const matches=findMatches(els.search.value); if (event.key === "ArrowDown") { event.preventDefault(); searchIndex=Math.min(searchIndex+1,matches.length-1); renderSearch(); }
    if (event.key === "ArrowUp") { event.preventDefault(); searchIndex=Math.max(searchIndex-1,0); renderSearch(); }
    if (event.key === "Enter" && searchIndex >= 0 && matches[searchIndex]) { event.preventDefault(); choosePlayer(matches[searchIndex].id); }
  });
  els.results.addEventListener("click", function (event) { const button=event.target.closest("[data-id]"); if (button) choosePlayer(button.dataset.id); });
  els.form.addEventListener("submit", function (event) {
    event.preventDefault(); const exact=players.find(function (p) { return p.id.toLowerCase()===els.search.value.trim().toLowerCase(); });
    if (!exact) { showToast("请从选手列表中选择一个有效 ID"); renderSearch(); return; }
    addGuess(exact, new FormData(els.form).get("source"));
  });
  els.list.addEventListener("click", function (event) { const remove=event.target.closest("[data-remove]"); if(remove){history.splice(Number(remove.dataset.remove),1);save();render();return;} const button=event.target.closest(".feedback-btn"); if(button){event.stopPropagation();openFeedbackMenu(button);} });
  document.addEventListener("click", function (event) { if(!event.target.closest(".feedback-cell")) document.querySelectorAll(".feedback-menu").forEach(function(m){m.remove();}); if(!event.target.closest(".search-wrap")) els.results.classList.remove("open"); });
  document.addEventListener("click", function (event) { const button=event.target.closest("[data-use]"); if(button){choosePlayer(button.dataset.use); window.scrollTo({top:Math.max(0,$(".guess-panel").offsetTop-90),behavior:"smooth"}); els.search.focus();} });
  filterConfigs.forEach(bindCandidateFilter);
  [els.candidateSearch,els.filterRegion,els.filterTeam,els.filterCountry,els.filterRole,els.filterStatus,els.filterAgeMin,els.filterAgeMax,els.filterMajorWinsMin,els.filterMajorWinsMax,els.filterMajorAppsMin,els.filterMajorAppsMax].forEach(function(control){control.addEventListener("input",function(){page=1;render();});});
  document.querySelectorAll("[data-candidate-sort]").forEach(function(button){button.addEventListener("click",function(){els.candidateSort.value=button.dataset.candidateSort;document.querySelectorAll("[data-candidate-sort]").forEach(function(item){item.classList.toggle("active",item===button);});page=1;render();});});
  els.clearFilters.addEventListener("click",function(){els.candidateSearch.value="";[els.filterRegion,els.filterTeam,els.filterCountry,els.filterRole,els.filterStatus,els.filterAgeMin,els.filterAgeMax,els.filterMajorWinsMin,els.filterMajorWinsMax,els.filterMajorAppsMin,els.filterMajorAppsMax].forEach(function(control){control.value="";});closeFilterMenus();page=1;render();});
  document.addEventListener("click",function(event){if(!event.target.closest(".filter-combobox"))closeFilterMenus();});
  els.pagination.addEventListener("click",function(event){const b=event.target.closest("[data-page]");if(b){page=Number(b.dataset.page);render();}});
  els.undo.addEventListener("click",function(){history.pop();save();render();}); els.reset.addEventListener("click",function(){if(confirm("清空本轮所有反馈？")){history=[];save();render();}});
  $("#loadDemo").addEventListener("click",function(){const target=players.find(function(p){return p.id==="ZywOo";});const ids=["friberg","stavn","molodoy"];history=ids.map(function(id,i){const p=players.find(function(x){return x.id===id;});const feedback={};Engine.FIELD_ORDER.forEach(function(field){feedback[field]=Engine.feedbackForField(p,target,field);});return{player:Object.assign({},p),source:i===2?"opponent":"me",feedback:feedback,createdAt:Date.now()+i};});save();render();showToast("已按 ZywOo 为隐藏答案载入演示");});

  document.querySelectorAll("[data-modal]").forEach(function(b){b.addEventListener("click",function(){$("#"+b.dataset.modal).hidden=false;});});
  document.querySelectorAll(".modal-wrap").forEach(function(wrap){wrap.addEventListener("click",function(e){if(e.target===wrap||e.target.closest(".modal-close"))wrap.hidden=true;});});
  $("#exportData").addEventListener("click",function(){const blob=new Blob([JSON.stringify(players,null,2)],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="fragle-players.json";link.click();URL.revokeObjectURL(link.href);});
  $("#importData").addEventListener("change",function(event){const file=event.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=function(){try{const data=JSON.parse(reader.result);const fields=["id","team","country","region","age","role","majorWins","majorApps","status"];if(!Array.isArray(data)||!data.length||data.some(function(p){return fields.some(function(f){return p[f]===undefined;});}))throw new Error("format");players=data;localStorage.setItem(STORAGE.players,JSON.stringify(players));history=[];save();populateCandidateFilters();render();$("#dataModal").hidden=true;showToast("已导入 "+players.length+" 位选手");}catch(_){showToast("JSON 格式不正确");}};reader.readAsText(file);event.target.value="";});
  $("#restoreData").addEventListener("click",function(){players=builtInPlayers.slice();localStorage.removeItem(STORAGE.players);history=[];save();populateCandidateFilters();render();showToast("已恢复内置选手库");});

  populateCandidateFilters();
  render();
})();




