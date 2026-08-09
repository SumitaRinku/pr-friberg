(function(){
"use strict";
var operators=Array.isArray(globalThis.ARKNIGHTS_OPERATORS)?globalThis.ARKNIGHTS_OPERATORS:[];
var el={
  search:document.querySelector("#toolSearch"),
  classFilter:document.querySelector("#filterClass"),
  subclass:document.querySelector("#filterSubclass"),
  rarity:document.querySelector("#filterRarity"),
  faction:document.querySelector("#filterFaction"),
  year:document.querySelector("#filterYear"),
  position:document.querySelector("#filterPosition"),
  reset:document.querySelector("#resetFilters"),
  rows:document.querySelector("#operatorRows"),
  count:document.querySelector("#operatorCount"),
  summary:document.querySelector("#filterSummary"),
  noResults:document.querySelector("#noResults")
};
function esc(value){return String(value==null?"":value).replace(/[&<>'"]/g,function(character){return{"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[character]})}
function norm(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()}
function values(field){
  return Array.from(new Set(operators.flatMap(function(operator){
    var value=operator[field];
    return Array.isArray(value)?value:[value];
  }).filter(Boolean))).sort(function(a,b){
    return typeof a==="number"?b-a:String(a).localeCompare(String(b),"zh-CN");
  });
}
function options(select,list,suffix){
  list.forEach(function(value){
    var option=document.createElement("option");
    option.value=value;
    option.textContent=value+(suffix||"");
    select.appendChild(option);
  });
}
function alterText(operator){return operator.hasAlter?"有":"无"}
function factionText(operator){
  return "<b>"+esc(operator.faction)+"</b>"+(operator.group&&operator.group!==operator.faction?"<small>"+esc(operator.group)+"</small>":"");
}
function row(operator){
  return "<tr>"+
    "<td class=\"operator-name\"><b>"+esc(operator.name)+"</b><small>"+esc(operator.en)+"</small></td>"+
    "<td><span class=\"ak-rarity\">"+operator.rarity+"★</span></td>"+
    "<td class=\"ak-stacked\"><b>"+esc(operator.class)+"</b><small>"+esc(operator.subclass)+"</small></td>"+
    "<td class=\"ak-stacked\">"+factionText(operator)+"</td>"+
    "<td><span class=\"ak-number\">"+operator.year+"</span></td>"+
    "<td><span class=\"ak-pills\">"+operator.tags.map(function(tag){return"<i>"+esc(tag)+"</i>"}).join("")+"</span></td>"+
    "<td>"+esc(operator.position.join(" / "))+"</td>"+
    "<td><span class=\"ak-binary "+(operator.hasAlter?"yes":"no")+"\">"+alterText(operator)+"</span></td>"+
  "</tr>";
}
function filtered(){
  var query=norm(el.search.value.trim());
  return operators.filter(function(operator){
    if(el.classFilter.value&&operator.class!==el.classFilter.value)return false;
    if(el.subclass.value&&operator.subclass!==el.subclass.value)return false;
    if(el.rarity.value&&String(operator.rarity)!==el.rarity.value)return false;
    if(el.faction.value&&operator.faction!==el.faction.value)return false;
    if(el.year.value&&String(operator.year)!==el.year.value)return false;
    if(el.position.value&&!operator.position.includes(el.position.value))return false;
    if(query){
      var haystack=[operator.name,operator.en,operator.id,operator.class,operator.subclass,operator.faction,operator.group]
        .concat(operator.tags,operator.position).map(norm).join(" ");
      if(!haystack.includes(query))return false;
    }
    return true;
  }).sort(function(a,b){
    return b.rarity-a.rarity||b.year-a.year||a.name.localeCompare(b.name,"zh-CN");
  });
}
function render(){
  var list=filtered();
  el.rows.innerHTML=list.map(row).join("");
  el.noResults.hidden=list.length>0;
  el.rows.closest("table").hidden=list.length===0;
  el.count.textContent=operators.length;
  el.summary.textContent=list.length===operators.length?"全部 "+operators.length+" 位干员":"已筛选 "+list.length+" / "+operators.length;
}
options(el.classFilter,values("class"));
options(el.subclass,values("subclass"));
options(el.rarity,values("rarity"),"★");
options(el.faction,values("faction"));
options(el.year,values("year")," 年");
options(el.position,values("position"));
[el.search,el.classFilter,el.subclass,el.rarity,el.faction,el.year,el.position].forEach(function(control){
  control.addEventListener(control.tagName==="INPUT"?"input":"change",render);
});
el.reset.addEventListener("click",function(){
  [el.search,el.classFilter,el.subclass,el.rarity,el.faction,el.year,el.position].forEach(function(control){control.value=""});
  render();
  el.search.focus();
});
render();
}());