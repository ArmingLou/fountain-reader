/**
 * Rust 解析结果适配层
 * 将 betterfountain-rust 的数据结构转换为前端期望的格式
 */

export interface AdaptedToken {
  type: string;
  text: string;
  textNoNotes?: string;
  line: number;
  start: number;
  end: number;
  ignore: boolean;
  number?: string;
  dual?: string;
  level?: number;
  time?: number;
  character?: string;
  charactersAction?: string[];
  playTimeSec: number;
  index: number;
  takeNumber?: number;
}

export interface AdaptedProperties {
  lengthAction: number;
  lengthDialogue: number;
  lenWords?: number;
  lenChars?: number;
  scenes: Array<{
    text: string;
    number?: string;
    startPlaySec: number;
    endPlaySec: number;
    actionLength: number;
    dialogueLength: number;
  }>;
  locations: Map<string, Array<{
    scene_number: string;
    line: number;
    startPlaySec: number;
    interior: boolean;
    exterior: boolean;
    time_of_day: string;
  }>>;
  characterSceneNumber: Map<string, Set<string>>;
  firstSceneLine: number;
  structure: any[];
}

export interface AdaptedParseOutput {
  tokens: AdaptedToken[];
  properties: AdaptedProperties;
  dial_sec_per_char: number;
  dial_sec_per_punc_short: number;
  dial_sec_per_punc_long: number;
  lengthDialogue: number;
  lengthAction: number;
  lenWords?: number;
  lenChars?: number;
  statistics?: any;
}

/**
 * 将 Rust 返回的解析结果适配为前端期望的格式
 */
export function adaptParseOutput(rustOutput: any): AdaptedParseOutput {
  if (!rustOutput) {
    return {
      tokens: [],
      properties: {
        lengthAction: 0,
        lengthDialogue: 0,
        scenes: [],
        locations: new Map(),
        characterSceneNumber: new Map(),
        firstSceneLine: -1,
        structure: []
      },
      dial_sec_per_char: 0.05,
      dial_sec_per_punc_short: 0.3,
      dial_sec_per_punc_long: 0.5,
      lengthDialogue: 0,
      lengthAction: 0
    };
  }

  const tokens = (rustOutput.tokens || []).map((t: any) => adaptToken(t));
  const properties = adaptProperties(rustOutput.properties || {});
  
  // 计算词数和字符数
  let totalWords = 0;
  let totalChars = 0;
  tokens.forEach((t: AdaptedToken) => {
    const text = t.text || '';
    totalChars += text.length;
    totalWords += text.split(/\s+/).filter((w: string) => w.length > 0).length;
  });

  return {
    tokens,
    properties,
    dial_sec_per_char: rustOutput.dial_sec_per_char || 0.05,
    dial_sec_per_punc_short: rustOutput.dial_sec_per_punc_short || 0.3,
    dial_sec_per_punc_long: rustOutput.dial_sec_per_punc_long || 0.5,
    lengthDialogue: rustOutput.length_dialogue || rustOutput.lengthDialogue || 0,
    lengthAction: rustOutput.length_action || rustOutput.lengthAction || 0,
    lenWords: totalWords,
    lenChars: totalChars,
    statistics: convertStatistics(rustOutput.statistics)
  };
}

function adaptToken(t: any): AdaptedToken {
  return {
    type: t.token_type || t.type || "",
    text: t.text || "",
    textNoNotes: t.text_no_notes || t.textNoNotes,
    line: t.line || 0,
    start: t.start || 0,
    end: t.end || 0,
    ignore: t.ignore || false,
    number: t.number,
    dual: t.dual,
    level: t.level,
    time: t.time || t.duration_sec || 0,
    character: t.character,
    charactersAction: t.characters_action || t.charactersAction,
    playTimeSec: t.play_time_sec || t.playTimeSec || 0,
    index: t.index ?? -1,
    takeNumber: t.take_number || t.takeNumber
  };
}

function adaptProperties(props: any): AdaptedProperties {
  const scenes = (props.scenes || []).map((s: any) => ({
    text: s.text || "",
    number: s.number,
    startPlaySec: s.startPlaySec || s.start_play_sec || 0,
    endPlaySec: s.endPlaySec || s.end_play_sec || 0,
    actionLength: s.actionLength || s.action_length || 0,
    dialogueLength: s.dialogueLength || s.dialogue_length || 0
  }));

  const locations = new Map();
  if (props.locations) {
    for (const [key, value] of Object.entries(props.locations)) {
      locations.set(key, (value as any[]).map((loc: any) => ({
        scene_number: loc.scene_number || "",
        line: loc.line || 0,
        startPlaySec: loc.startPlaySec || loc.start_play_sec || 0,
        interior: loc.interior || false,
        exterior: loc.exterior || false,
        time_of_day: loc.time_of_day || loc.timeOfDay || ""
      })));
    }
  }

  const characterSceneNumber = new Map();
  if (props.characterSceneNumber) {
    for (const [key, value] of Object.entries(props.characterSceneNumber)) {
      characterSceneNumber.set(key, new Set(value as string[]));
    }
  }

  return {
    lengthAction: props.length_action || props.lengthAction || 0,
    lengthDialogue: props.length_dialogue || props.lengthDialogue || 0,
    lenWords: props.len_words || props.lenWords,
    lenChars: props.len_chars || props.lenChars,
    scenes,
    locations,
    characterSceneNumber,
    firstSceneLine: props.firstSceneLine || props.first_scene_line || -1,
    structure: props.structure || []
  };
}

function convertStatistics(snakeStats: any): any {
  if (!snakeStats) return undefined;
  
  const convertCharacterStat = (cs: any) => ({
    name: cs.name,
    speakingParts: cs.speaking_parts,
    wordsSpoken: cs.words_spoken,
    secondsSpoken: cs.seconds_spoken,
    secondsTotal: cs.seconds_total,
    averageComplexity: cs.average_complexity,
    monologues: cs.monologues,
    numberOfScenes: cs.number_of_scenes,
    color: cs.color,
  });
  
  const convertCharacterStats = (cs: any) => {
    if (!cs) return undefined;
    return {
      characters: (cs.characters || []).map(convertCharacterStat),
      complexity: cs.complexity,
      characterCount: cs.character_count,
      monologues: cs.monologues,
    };
  };
  
  const convertLocationStat = (ls: any) => ({
    name: ls.name,
    sceneNumbers: ls.scene_numbers,
    sceneLines: ls.scene_lines,
    numberOfScenes: ls.number_of_scenes,
    timesOfDay: ls.times_of_day,
    interiorExterior: ls.interior_exterior,
    color: ls.color,
  });
  
  const convertLocationStats = (ls: any) => {
    if (!ls) return undefined;
    return {
      locations: (ls.locations || []).map(convertLocationStat),
      locationsCount: ls.locations_count,
    };
  };
  
  const convertSceneStat = (ss: any) => ({
    title: ss.title,
  });
  
  const convertSceneStats = (ss: any) => {
    if (!ss) return undefined;
    return {
      scenes: (ss.scenes || []).map(convertSceneStat),
    };
  };
  
  const convertLengthChartItem = (item: any) => ({
    line: item.line,
    playTimeSec: item.play_time_sec,
    scene: item.scene,
    length: item.length,
  });
  
  const convertSceneItem = (item: any) => ({
    line: item.line,
    endline: item.endline,
    scene: item.scene,
    type: item.type,
    time: item.time,
  });
  
  const convertDurationByProp = (dp: any) => ({
    prop: dp.prop,
    duration: dp.duration,
  });
  
  const convertDurationStats = (ds: any) => {
    if (!ds) return undefined;
    return {
      dialogue: ds.dialogue,
      action: ds.action,
      total: ds.total,
      lengthchart_action: (ds.lengthchart_action || []).map(convertLengthChartItem),
      lengthchart_dialogue: (ds.lengthchart_dialogue || []).map(convertLengthChartItem),
      durationBySceneProp: (ds.duration_by_scene_prop || []).map(convertDurationByProp),
      scenes: (ds.scenes || []).map(convertSceneItem),
      monologues: ds.monologues,
      characters: (ds.characters || []).map((timeline: any[]) =>
        (timeline || []).map((item: any) => ({
          line: item.line,
          playTimeSec: item.play_time_sec,
          scene: item.scene,
          lengthTimeGlobal: item.length_time_global,
          lengthWordsGlobal: item.length_words_global,
          monologue: item.monologue,
          lengthTime: item.length_time,
          lengthWords: item.length_words,
          cumulativeTime: item.length_time_global,
        }))
      ),
      characternames: ds.characternames || [],
    };
  };
  
  return {
    characterStats: convertCharacterStats(snakeStats.character_stats),
    sceneStats: convertSceneStats(snakeStats.scene_stats),
    locationStats: convertLocationStats(snakeStats.location_stats),
    durationStats: convertDurationStats(snakeStats.duration_stats),
  };
}
