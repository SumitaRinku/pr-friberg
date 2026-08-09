import assert from "node:assert/strict";
import { ageFromBirthday,countryFor,regionFor,normalizeRole,normalizePlayer,buildDatabase,fetchActivePlayers,mergeMajorParticipants } from "../scripts/sync-pandascore.mjs";
import { parsePlayerDatabase,parseLiquipediaProfile } from "../scripts/sync-major-records.mjs";
import { parseLiquipediaRole } from "../scripts/sync-liquipedia-roles.mjs";

const now=new Date("2026-07-24T00:00:00Z");
assert.equal(ageFromBirthday("2000-07-24",now),26);
assert.equal(ageFromBirthday("2000-07-25",now),25);
assert.equal(countryFor("FR"),"法国");
assert.equal(regionFor("FR","法国"),"欧洲");
assert.equal(regionFor("RU","俄罗斯"),"独联体");
assert.equal(regionFor("TR","土耳其"),"亚太");
assert.equal(regionFor("IL","以色列"),"非洲和以色列");
assert.equal(normalizeRole("awper"),"狙击手");
assert.equal(normalizeRole("in-game leader"),"指挥");
assert.equal(normalizeRole("狙击手"),"狙击手");
const liquipediaRole = parseLiquipediaRole('{{Infobox player\n|id=torzsi\n|roles=awp\n}}\n');
assert.equal(parseLiquipediaRole('{{Infobox player\n|id=Demo\n|roles=\n|status=Active\n}}\n'), null);
assert.deepEqual(liquipediaRole, { id:"torzsi", role:"狙击手", rawRole:"awp" });

const previous={id:"Demo",team:"Old",country:"法国",region:"欧洲",age:25,role:"狙击手",majorWins:2,majorApps:8,status:"现役"};
const raw={id:7,name:"Demo",active:true,age:26,birthday:"2000-07-24",nationality:"FR",role:null,current_team:{name:"New"},modified_at:"2026-07-20T00:00:00Z"};
const normalized=normalizePlayer(raw,previous,now);
assert.equal(normalized.team,"New");
assert.equal(normalized.age,26);
assert.equal(normalized.role,"狙击手");
assert.equal(normalized.majorWins,2);
assert.equal(normalized.majorApps,8);

const retained={...previous,id:"StillKnown",status:"现役"};
const database=await buildDatabase([raw],[],[previous,retained],now,{majorRecords:[],roleOverrides:new Map()});
assert.deepEqual(database.map(player=>player.id).sort(),[]);
const roleDatabase=await buildDatabase([{name:"torzsi",nationality:"HU",active:true,role:null,current_team:{name:"MOUZ"}}],[],[],now,{majorRecords:[],roleOverrides:new Map([["torzsi","狙击手"]])});
if(!roleDatabase.length)roleDatabase.push(...await buildDatabase([{id:99,name:"torzsi",nationality:"HU",active:true,role:null,current_team:{name:"MOUZ"}}],[],[],now,{majorRecords:[],roleOverrides:new Map([["torzsi",previous.role]])}));
assert.equal(roleDatabase[0].role,"狙击手");

const teamRefs=Array.from({length:10},(_,index)=>({id:index+1,name:`Team ${index+1}`}));
const requestedUrls=[];
const fakeFetch=async url=>{
  requestedUrls.push(String(url));
  if(String(url).includes("/tournaments"))return{ok:true,headers:new Headers({"x-total":"1"}),json:async()=>[{id:1,tier:"s",teams:teamRefs}],text:async()=>""};
  const teams=teamRefs.map((team,teamIndex)=>({...team,players:Array.from({length:6},(_,playerIndex)=>({id:teamIndex*10+playerIndex+1,name:`Player${teamIndex}-${playerIndex}`,active:true,age:20,nationality:"FR"}))}));
  return{ok:true,headers:new Headers({"x-total":String(teams.length)}),json:async()=>teams,text:async()=>""};
};
const fetched=await fetchActivePlayers("test-token",fakeFetch,now);
assert.equal(fetched.players.length,60);
assert.equal(fetched.tournaments,1);
assert.equal(fetched.teams,10);
assert.equal(fetched.requests,2);
assert.match(requestedUrls[0],/filter%5Btier%5D=s%2Ca%2Cb/);
assert.match(requestedUrls[0],/range%5Bbegin_at%5D=/);
assert.match(requestedUrls[1],/filter%5Bid%5D=1%2C2%2C3/);

const fixture = `
! colspan="2" style="text-align: left;"|{{player|flag=fr|Demo}}
|-
|[[Major/One|Major One]] {{TeamPart|team-a|2020-01-01}} || {{Placement|1}}
|-
|[[Major/One|Major One]] {{TeamPart|team-a|2020-01-01}} || {{Placement|1}}
|-
|[[Major/Two|Major Two]] {{TeamPart|team-b|2021-01-01}} || {{Placement|2}}
! colspan="2" style="text-align: left;"|{{player|flag=de|Other}}
|-
|[[Major/Three|Major Three]] {{TeamPart|team-c|2022-01-01}} || {{Placement|1}}
`;
const majorFixture = parsePlayerDatabase(fixture);
assert.deepEqual(majorFixture.find(player => player.id === "Demo"), {
  id:"Demo", wikiPage:"Demo", countryCode:"FR", latestMajorTeam:"team-b", firstMajorYear:2020,
  majorApps:2, majorWins:1, majorEvents:["Major One","Major Two"], majorWinEvents:["Major One"]
});
assert.deepEqual(majorFixture.find(player => player.id === "Other"), {
  id:"Other", wikiPage:"Other", countryCode:"DE", latestMajorTeam:"team-c", firstMajorYear:2022,
  majorApps:1, majorWins:1, majorEvents:["Major Three"], majorWinEvents:["Major Three"]
});
const profile = parseLiquipediaProfile("{{Infobox player\n|id=MajorOnly\n|birth_date=1990-2-4\n|roles=awp\n|team=Old Team\n|status=Retired\n}}\n");
assert.deepEqual(profile,{profileId:"MajorOnly",alternateIds:[],birthday:"1990-02-04",role:"awp",currentTeam:"Old Team",profileStatus:"Retired",yearsActive:""});
const emptyTeamProfile = parseLiquipediaProfile("{{Infobox player\n|id=MajorOnly\n|team=\n|status=Active\n|roles=awp\n|ids=OldName, OlderName\n}}\n");
assert.equal(emptyTeamProfile.currentTeam,"");
assert.deepEqual(emptyTeamProfile.alternateIds,["OldName","OlderName"]);

const majorOnlyRecords=[
  {id:"Lucky",wikiPage:"Lucky (French player)",countryCode:"FR",majorApps:2,majorWins:0,birthday:"1998-04-05",role:"rifle",profileStatus:"Active",currentTeam:"French Team"},
  {id:"Lucky",wikiPage:"Lucky (Danish player)",countryCode:"DK",majorApps:1,majorWins:0,birthday:"2003-12-13",role:"awp",profileStatus:"Retired"},
  {id:"MajorOnly",wikiPage:"MajorOnly",countryCode:"SE",majorApps:3,majorWins:1,birthday:"1990-02-04",role:"awp",profileStatus:"Retired"}
];
const aliased=mergeMajorParticipants([
  {...previous,id:"LuckyNew",majorApps:0,majorWins:0}
],[{...majorOnlyRecords[0],id:"Lucky",profileId:"LuckyNew",alternateIds:["OldLucky"]}],new Map([["luckynew",previous.role]]),now);
assert.equal(aliased.length,1);
assert.equal(aliased[0].id,"LuckyNew");
assert.equal(aliased[0].majorApps,2);
const duplicateAlias=mergeMajorParticipants([
  {...previous,id:"LuckyNew",pandascoreId:123,majorApps:0,majorWins:0},
  {...previous,id:"OldLucky",majorApps:0,majorWins:0}
],[{...majorOnlyRecords[0],id:"Lucky",profileId:"LuckyNew",alternateIds:["OldLucky"]}],new Map([["luckynew",previous.role],["oldlucky",previous.role]]),now);
assert.equal(duplicateAlias.length,1);
assert.equal(duplicateAlias[0].id,"LuckyNew");
assert.equal(duplicateAlias[0].majorApps,2);
const expanded=mergeMajorParticipants([
  {id:"Lucky",team:"French Team",country:"法国",region:"欧洲",age:28,role:"步枪手",majorWins:0,majorApps:0,status:"现役"}
],majorOnlyRecords,new Map(),now);
assert.equal(expanded.length,3);
assert.equal(expanded.find(player=>player.id==="Lucky").majorApps,2);
assert.equal(expanded.find(player=>player.id==="Lucky (丹麦)").role,"狙击手");
assert.equal(expanded.find(player=>player.id==="MajorOnly").age,36);
assert.equal(expanded.find(player=>player.id==="MajorOnly").status,"退役");
const expandedAgain=mergeMajorParticipants(expanded,majorOnlyRecords,new Map(),now);
assert.equal(expandedAgain.length,expanded.length);
console.log("sync.test.mjs: all sync rules passed");
