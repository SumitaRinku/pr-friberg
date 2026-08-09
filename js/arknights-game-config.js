(function(){
  "use strict";
  function normalize(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[\s'’._-]/g,"");}
  function alterText(operator){return operator?.hasAlter?"有":"无";}
  function suggestionHtml(operator,escape){return `<button type="button" data-player="${escape(operator.id)}"><b>${escape(operator.name)}</b><small>${escape(operator.en)} · ${escape(operator.class)} / ${escape(operator.subclass)}</small><span>${operator.rarity}★</span></button>`;}
  function board({title,guesses,hiddenOpponent,boardKey,cell,escape,items,maxGuesses}){
    if(!guesses.length)return `<div class="board-card"><div class="board-label"><b>${escape(title)}</b><span>0 / ${maxGuesses}</span></div><div class="empty-board">还没有猜测记录</div></div>`;
    const rows=guesses.map((row,index)=>{
      const operator=row.player,hidden=hiddenOpponent&&!operator,guessKey=`${boardKey}:${index}`;
      const nameContent=!hidden&&operator?`<strong>${escape(operator.name)}</strong><small>${escape(operator.en)}</small>`:"";
      const factionContent=!hidden&&operator?`<span>${escape(operator.faction)}</span><small>${escape(operator.group)}</small>`:"";
      const tagContent=!hidden&&operator?`<span class="ak-cell-tags">${escape(operator.tags.join(" · "))}</span>`:"";
      return `<tr data-guess-key="${escape(guessKey)}">${cell(operator?.name,row.feedback.nickname,hidden,"干员","name",nameContent)}${cell(operator?`${operator.rarity}★`:"",row.feedback.rarity,hidden,"星级","rarity")}${cell(operator?.class,row.feedback.class,hidden,"职业","class")}${cell(operator?.subclass,row.feedback.subclass,hidden,"子职业","subclass")}${cell(operator?.faction,row.feedback.faction,hidden,"阵营","faction",factionContent)}${cell(operator?.year,row.feedback.year,hidden,"年份","year")}${cell(operator?.tags?.join(" · "),row.feedback.tags,hidden,"词缀","tags",tagContent)}${cell(operator?.position?.join(" / "),row.feedback.position,hidden,"部署位","position")}${cell(alterText(operator,items),row.feedback.alter,hidden,"异格","alter")}</tr>`;
    }).join("");
    return `<div class="board-card arknights-board"><div class="board-label"><b>${escape(title)}</b><span>${guesses.length} / ${maxGuesses}${hiddenOpponent?" · 仅显示反馈":""}</span></div><div class="ak-game-table-scroll"><table class="game-table arknights-game-table"><colgroup><col class="ak-col-name"><col class="ak-col-rarity"><col class="ak-col-class"><col class="ak-col-subclass"><col class="ak-col-faction"><col class="ak-col-year"><col class="ak-col-tags"><col class="ak-col-position"><col class="ak-col-alter"></colgroup><thead><tr><th>干员</th><th>星级</th><th>职业</th><th>子职业</th><th>阵营</th><th>年份</th><th>词缀</th><th>部署位</th><th>异格</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  function answerCard(operator,escape,items){
    if(!operator)return "";
    const facts=[["星级",`${operator.rarity}★`],["职业",operator.class],["子职业",operator.subclass],["阵营",operator.faction],["年份",operator.year],["词缀",operator.tags.join(" · ")],["部署位",operator.position.join(" / ")],["异格",alterText(operator,items)]];
    return `<section class="answer-player answer-operator" aria-label="答案干员资料"><div class="answer-player-head"><span class="answer-player-badge">${operator.rarity}★</span><div><small>ANSWER OPERATOR</small><strong>${escape(operator.name)}</strong><span>${escape(operator.en)}</span></div></div><div class="answer-player-facts">${facts.map(([label,value])=>`<div><span>${label}</span><strong>${escape(value??"—")}</strong></div>`).join("")}</div></section>`;
  }
  window.FRAGLE_GAME_CONFIG={
    apiRoot:"/api/arknights",
    basePath:"/arknights",
    storagePrefix:"arknights-friberg",
    dataPath:"/api/arknights/operators",
    maxGuesses:10,
    inviteBrand:"方舟弗一把",
    searchPlaceholder:"输入中文名或英文名，例如 斯卡蒂 / Skadi",
    submitLabel:"提交猜测",
    invalidSelection:"请从列表选择有效干员",
    loadItems:payload=>Array.isArray(payload.operators)?payload.operators:[],
    questionEligible:(operator,mode)=>mode==="simple"?Number(operator.rarity)>=3:mode==="beginner"?Number(operator.rarity)>=5:true,
    questionModeError:mode=>mode==="beginner"?"新手题库只包含 5★ 和 6★ 干员":"标准题库只包含 3★ 及以上干员",
    questionModeLabel:mode=>mode==="beginner"?"新手题库":mode==="simple"?"标准题库":"完整题库",
    suggestions:(query,items,mode)=>{const needle=normalize(query);if(!needle)return[];return items.filter(operator=>window.FRAGLE_GAME_CONFIG.questionEligible(operator,mode)&&[operator.name,operator.en,operator.id].some(value=>normalize(value).includes(needle))).slice(0,8);},
    suggestionHtml,
    board,
    answerCard:(operator,escape,items)=>answerCard(operator,escape,items),
    historyAnswer:(operator,escape)=>`<div class="history-answer"><span>答案</span><strong>${escape(operator.name)}</strong><small>${escape(operator.en)} · ${operator.rarity}★ ${escape(operator.class)}</small></div>`
  };
})();