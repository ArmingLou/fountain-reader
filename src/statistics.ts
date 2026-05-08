/**
 * Fountain 剧本统计算法
 * 基于 betterfountain 的 statistics.ts 实现
 * 包含角色统计、场景统计、地点统计、时长统计
 */

// ==================== 类型定义 ====================

/** 解析后的 token 类型 */
interface Token {
  type: string;
  text?: string;
  line?: number;
  name?: () => string;
  textNoNotes?: string;
  time?: number;
  playTimeSec?: number;
  charactersAction?: string[];
  character?: string;
}

/** 解析结果 */
interface ParsedOutput {
  tokens: Token[];
  properties: {
    lengthAction: number;
    lengthDialogue: number;
    lenWords?: number;
    lenChars?: number;
    scenes: Array<{
      text: string;
      number?: number;
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
  };
  dial_sec_per_char: number;
  dial_sec_per_punc_short: number;
  dial_sec_per_punc_long: number;
  lengthDialogue: number;
  lengthAction: number;
}

/** 角色统计数据项 */
interface DialogueStatisticPerCharacter {
  name: string;
  speakingParts: number;
  wordsSpoken: number;
  secondsSpoken: number;
  averageComplexity: number;
  monologues: number;
  number_of_scenes: number;
  color: string;
}

/** 角色统计结果 */
interface CharacterStatistics {
  characters: DialogueStatisticPerCharacter[];
  complexity: number;
  characterCount: number;
  monologues: number;
}

/** 地点统计数据项 */
interface LocationStatisticPerLocation {
  name: string;
  color: string;
  scene_numbers: string[];
  scene_lines: number[];
  number_of_scenes: number;
  times_of_day: string[];
  interior_exterior: 'int' | 'ext' | 'ie' | 'multiple' | 'unknown';
}

/** 地点统计结果 */
interface LocationStatistics {
  locations: LocationStatisticPerLocation[];
  locationsCount: number;
}

/** 场景统计数据项 */
interface SingleSceneStatistic {
  title: string;
}

/** 场景统计结果 */
interface SceneStatistics {
  scenes: SingleSceneStatistic[];
}

/** 时长图表数据项 */
interface LengthChartItem {
  line: number;
  playTimeSec: number;
  scene: string;
  length: number;
}

/** 场景数据项 */
interface SceneItem {
  line: number;
  endline: number;
  scene: string;
  type: 'int' | 'ext' | 'ie' | 'unknown';
  time: string;
}

/** 时长统计结果 */
interface DurationStatistics {
  dialogue: number;
  action: number;
  total: number;
  lengthchart_action: LengthChartItem[];
  lengthchart_dialogue: LengthChartItem[];
  durationBySceneProp: Array<{ prop: string; duration: number }>;
  scenes: SceneItem[];
  monologues: number;
}

// ==================== 辅助函数 ====================

/**
 * 计算对话时长（秒）
 * @param dialogue 对话文本
 * @param dialSecPerChar 每个字符的时长（秒）
 * @param dialSecPerPuncShort 短标点时长（秒）
 * @param dialSecPerPuncLong 长标点时长（秒）
 */
export function calculateDialogueDuration(
  dialogue: string,
  dialSecPerChar: number = 0.1945548,
  dialSecPerPuncShort: number = 0.3,
  dialSecPerPuncLong: number = 0.75
): number {
  let duration = 0;

  // 去除空格、标点、特殊字符后计算字符数
  const sanitized = dialogue.replace(/\s|\p{P}|\p{S}/giu, '');
  duration += sanitized.length * dialSecPerChar;

  // 计算标点符号带来的停顿时长
  const rec = /(\.|\?|\!|\:|。|？|！|：)|(\,|，|;|；|、)/g;
  let resu: RegExpExecArray | null;
  while ((resu = rec.exec(dialogue)) !== null) {
    if (!resu[0]) break;
    if (resu[1]) {
      duration += dialSecPerPuncLong; // 长标点（句号、问号等）
    }
    if (resu[2]) {
      duration += dialSecPerPuncShort; // 短标点（逗号、分号等）
    }
  }

  return duration;
}

/**
 * 判断是否为独白（超过 30 秒）
 * @param seconds 时长（秒）
 */
export function isMonologue(seconds: number): boolean {
  return seconds > 30;
}

/**
 * 计算中位数
 * @param values 数值数组
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  
  if (sorted.length % 2) {
    return sorted[half];
  } else {
    return (sorted[half - 1] + sorted[half]) / 2.0;
  }
}

/**
 * 将字符串转换为颜色（RGB）
 * 使用 HSV 色彩空间确保颜色区分度
 * @param word 输入字符串
 * @param s 饱和度（默认 0.7）
 * @param v 明度（默认 0.7）
 */
export function wordToColor(word: string, s: number = 0.7, v: number = 0.7): [number, number, number] {
  // 计算字符串 hash
  const hash = hashString(word);
  
  // 调整饱和度和明度以增加区分度
  const sDiff = (1 - s) * 100;
  if (sDiff > 0) {
    s = ((hash * 19) % sDiff) / 100 + s;
  }
  
  const vDiff = (1 - v) * 100;
  if (vDiff > 0) {
    v = ((hash * 11) % vDiff) / 100 + v;
  }
  
  // 将字符串转换为色相
  const h = stringToHue(hash, 360);
  
  return hsvToRgb(h, s, v);
}

/**
 * RGB 转十六进制颜色
 * @param rgb RGB 数组 [r, g, b]
 */
export function rgbToHex(rgb: [number, number, number]): string {
  const componentToHex = (c: number): string => {
    const hex = Math.round(c).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  
  return '#' + componentToHex(rgb[0]) + componentToHex(rgb[1]) + componentToHex(rgb[2]);
}

/**
 * 计算字符串的字符数（不含空白）
 */
function getCharacterCountWithoutWhitespace(script: string): number {
  return ((script || '').match(/\S+?/g) || []).length;
}

// ==================== 私有辅助函数 ====================

/**
 * HSV 转 RGB
 */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * 字符串转色相值
 */
function stringToHue(hash: number, colorSplits: number = 360): number {
  const h = (hash * 157 % colorSplits) / colorSplits;
  return h;
}

/**
 * 字符串 hash 函数
 */
function hashString(str: string): number {
  let hash = 0;
  const ls: number[] = [];
  
  for (let i = 0; i < str.length; i++) {
    const codePoint = str.codePointAt(i) || 0;
    const mod = codePoint % 256;
    let hashTemp = ((hash << 5) - hash + mod) | 0;
    
    if (hashTemp < 0) {
      ls.push(hash);
      hash = mod;
    } else {
      hash = hashTemp;
    }
  }
  
  if (ls.length > 0) {
    const tot = ls.length + 1;
    hash = hash / tot;
    for (let i = 0; i < ls.length; i++) {
      hash += ls[i] / tot;
    }
  }
  
  hash |= 0;
  if (hash < 0) hash = -hash;
  return hash;
}

/**
 * 判断场景类型（内景/外景/内外景）
 */
function locationType(val: string): 'int' | 'ext' | 'ie' | 'unknown' {
  if (!val) return 'unknown';
  
  // 检查是否包含内外景标记
  if (/i(nt)?\.?\/e(xt)?\.?/i.test(val)) {
    return 'ie';
  } else if (/i(nt)?\.?/i.test(val)) {
    return 'int';
  } else if (/e(xt)?\.?/i.test(val)) {
    return 'ext';
  }
  
  return 'unknown';
}

/**
 * 提取破折号后的时间信息
 */
function afterDash(val: string): string | null {
  if (!val) return null;
  
  const dashes = ['-', '–', '—', '−'];
  for (const dash of dashes) {
    const idx = val.indexOf(dash);
    if (idx !== -1) {
      const n = val.substring(idx + 1).trim();
      if (n) return n;
    }
  }
  
  return null;
}

/**
 * 标准化时间描述
 */
function locationTime(val: string): string {
  if (!val) return 'unspecified';
  
  return val.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/g, '')
    .replace(/  +/g, ' ')
    .trim()
    .replace(/^(the)?\s*(next|following)\b/i, '')
    .replace(/^(early|late)\b/i, '')
    .trim() || 'unspecified';
}

// ==================== 核心统计函数 ====================

/**
 * 创建角色统计数据
 * @param parsed 解析后的 Fountain 数据
 */
export function createCharacterStatistics(parsed: ParsedOutput): CharacterStatistics {
  interface DialoguePiece {
    character: string;
    speech: string;
  }
  
  interface DialoguePerCharacter {
    [key: string]: string[];
  }
  
  const dialoguePieces: DialoguePiece[] = [];
  let firstSceneStarted = false;
  
  // 提取所有角色的对话
  for (let i = 0; i < parsed.tokens.length; i++) {
    if (parsed.tokens[i].type === 'scene_heading') {
      firstSceneStarted = true;
    }
    
    while (i < parsed.tokens.length && parsed.tokens[i].type === 'character') {
      const character = parsed.tokens[i].character || parsed.tokens[i].text?.replace(/\s*\(.*\)/, '').trim() || 'UNKNOWN';
      let speech = '';
      
      while (i++ && i < parsed.tokens.length) {
        const token = parsed.tokens[i];
        if (token.type === 'dialogue') {
          if (firstSceneStarted) {
            speech += (token.textNoNotes || token.text || '') + ' ';
          }
        } else if (token.type === 'character') {
          break;
        } else if (token.type === 'scene_heading') {
          firstSceneStarted = true;
        }
      }
      
      speech = speech.trim();
      if (speech) {
        dialoguePieces.push({ character, speech });
      }
    }
  }
  
  // 按角色分组对话
  const dialoguePerCharacter: DialoguePerCharacter = {};
  dialoguePieces.forEach((piece) => {
    if (!dialoguePerCharacter[piece.character]) {
      dialoguePerCharacter[piece.character] = [];
    }
    dialoguePerCharacter[piece.character].push(piece.speech);
  });
  
  // 计算每个角色的统计数据
  const characterStats: DialogueStatisticPerCharacter[] = [];
  const speechComplexityArray: number[] = [];
  let monologueCounter = 0;
  
  Object.keys(dialoguePerCharacter).forEach((characterName) => {
    const speeches = dialoguePerCharacter[characterName];
    
    // 过滤空对话
    const speakingParts = speeches.filter(s => s !== '').length;
    
    let secondsSpoken = 0;
    let monologues = 0;
    let combinedSentences = '';
    
    // 合并所有对话并计算时长
    const allDialogueCombined = speeches.reduce((prev, curr) => {
      const time = calculateDialogueDuration(
        curr,
        parsed.dial_sec_per_char,
        parsed.dial_sec_per_punc_short,
        parsed.dial_sec_per_punc_long
      );
      secondsSpoken += time;
      combinedSentences += '.' + curr;
      
      if (isMonologue(time)) {
        monologues++;
      }
      
      return `${prev} ${curr} `;
    }, '');
    
    monologueCounter += monologues;
    
    // 计算单词数（不含空白和标点）
    const wordsSpoken = getCharacterCountWithoutWhitespace(allDialogueCombined);
    
    // 计算场景数
    const characterScenes = parsed.properties.characterSceneNumber?.get(characterName);
    const numberOfScenes = characterScenes?.size || 0;
    
    characterStats.push({
      name: characterName,
      color: rgbToHex(wordToColor(characterName)),
      speakingParts,
      secondsSpoken,
      averageComplexity: 0, // 简化版本，暂不计算复杂度
      monologues,
      wordsSpoken,
      number_of_scenes: numberOfScenes,
    });
  });
  
  // 按台词数排序
  characterStats.sort((a, b) => {
    if (b.speakingParts !== a.speakingParts) {
      return b.speakingParts - a.speakingParts;
    }
    if (b.wordsSpoken !== a.wordsSpoken) {
      return b.wordsSpoken - a.wordsSpoken;
    }
    return 0;
  });
  
  return {
    characters: characterStats,
    complexity: median(speechComplexityArray),
    characterCount: characterStats.length,
    monologues: monologueCounter,
  };
}

/**
 * 创建场景统计数据
 * @param parsed 解析后的 Fountain 数据
 */
export function createSceneStatistics(parsed: ParsedOutput): SceneStatistics {
  // 按 VSCode 扩展逻辑：从 properties.scenes 提取 scene.number，去重
  const scenes = parsed.properties?.scenes || [];
  const sceneNumbers = scenes
    .map((s: any) => s.number)
    .filter((n: string) => n && n.trim().length > 0);
  
  const uniqueScenes = new Set(sceneNumbers);
  
  return { scenes: Array.from(uniqueScenes).map(n => ({ title: n })) };
}

/**
 * 创建地点统计数据
 * @param parsed 解析后的 Fountain 数据
 */
export function createLocationStatistics(parsed: ParsedOutput): LocationStatistics {
  const locationSlugs = Array.from(parsed.properties.locations?.keys() || []);
  
  const locations: LocationStatisticPerLocation[] = locationSlugs.map((locationSlug) => {
    const references = parsed.properties.locations?.get(locationSlug) || [];
    
    // 提取时间信息
    const timesOfDay = references
      .map(ref => locationTime(ref.time_of_day))
      .filter((v, i, a) => a.indexOf(v) === i);
    
    // 判断内外景
    const hasBoth = references.some(ref => ref.interior && ref.exterior);
    const hasInterior = references.some(ref => ref.interior && !ref.exterior);
    const hasExterior = references.some(ref => ref.exterior && !ref.interior);
    
    let interiorExterior: 'int' | 'ext' | 'ie' | 'multiple' | 'unknown' = 'unknown';
    let count = 0;
    
    if (hasBoth) {
      count++;
      interiorExterior = 'ie';
    }
    if (hasInterior) {
      count++;
      interiorExterior = 'int';
    }
    if (hasExterior) {
      count++;
      interiorExterior = 'ext';
    }
    if (count > 1) {
      interiorExterior = 'multiple';
    }
    
    // 计算唯一场景数
    const uniqueSceneNumbers = Array.from(
      new Set(
        references
          .map(ref => ref.scene_number)
          .filter(num => num)
      )
    ).length;
    
    return {
      name: locationSlug,
      color: rgbToHex(wordToColor(locationSlug)),
      scene_numbers: references.map(ref => ref.scene_number),
      scene_lines: references.map(ref => ref.startPlaySec),
      number_of_scenes: uniqueSceneNumbers,
      times_of_day: timesOfDay,
      interior_exterior: interiorExterior,
    };
  });
  
  return {
    locations,
    locationsCount: locationSlugs.length,
  };
}

/**
 * 创建时长统计数据
 * @param parsed 解析后的 Fountain 数据
 */
export function createDurationStatistics(parsed: ParsedOutput): DurationStatistics {
  const actionChart: LengthChartItem[] = [{ line: 0, length: 0, scene: '', playTimeSec: 0 }];
  const dialogueChart: LengthChartItem[] = [{ line: 0, length: 0, scene: '', playTimeSec: 0 }];
  const scenes: SceneItem[] = [];
  const durationByProp: Array<{ prop: string; duration: number }> = [];
  let previousLengthAction = 0;
  let previousLengthDialogue = 0;
  let currentScene = '';
  let monologues = 0;
  const scenePropDurations = new Map<string, number>();
  
  // 构建时长图表
  parsed.tokens.forEach((element) => {
    if (element.type === 'action' || element.type === 'dialogue') {
      const time = element.time || 0;
      
      if (element.type === 'action') {
        previousLengthAction += time;
        actionChart.push({
          line: element.line || 0,
          length: previousLengthAction,
          scene: currentScene,
          playTimeSec: element.playTimeSec || 0,
        });
      } else if (element.type === 'dialogue') {
        previousLengthDialogue += time;
        dialogueChart.push({
          line: element.line || 0,
          length: previousLengthDialogue,
          scene: currentScene,
          playTimeSec: element.playTimeSec || 0,
        });
        
        // 统计独白
        if (isMonologue(time)) {
          monologues++;
        }
      }
    }
  });
  
  // 处理场景信息
  parsed.properties.scenes?.forEach((scene) => {
    currentScene = scene.text;
    
    // 提取场景类型和时间
    const sceneHeadingMatch = scene.text.match(/^(?:\* *)?(?:([IE]\.?(?:\/[IE]\.?)?)[ ]+)?(.+?)(?:[-–—−](.+))?$/i);
    
    let sceneType: 'int' | 'ext' | 'ie' | 'unknown' = 'unknown';
    let sceneTime = 'unspecified';
    
    if (sceneHeadingMatch) {
      const typePart = sceneHeadingMatch[1];
      const timePart = sceneHeadingMatch[3];
      
      if (typePart) {
        sceneType = locationType(typePart);
      }
      
      if (timePart) {
        const timeStr = afterDash(timePart);
        if (timeStr) {
          sceneTime = locationTime(timeStr);
        }
      }
    }
    
    // 标准化时间描述
    const timeCategories = ['day', 'night', 'dawn', 'dusk', 'morning', 'evening'];
    const timeLower = sceneTime.toLowerCase();
    
    for (const category of timeCategories) {
      if (timeLower.includes(category)) {
        sceneTime = category;
        break;
      }
    }
    
    scenes.push({
      line: scene.startPlaySec,
      endline: scene.endPlaySec,
      scene: scene.text,
      type: sceneType,
      time: sceneTime,
    });
    
    // 统计场景类型时长
    const typeKey = `type_${sceneType}`;
    const currentTypeDuration = scenePropDurations.get(typeKey) || 0;
    scenePropDurations.set(typeKey, currentTypeDuration + scene.actionLength + scene.dialogueLength);
    
    // 统计时间类型时长
    const timeKey = `time_${sceneTime}`;
    const currentTimeDuration = scenePropDurations.get(timeKey) || 0;
    scenePropDurations.set(timeKey, currentTimeDuration + scene.actionLength + scene.dialogueLength);
  });
  
  // 转换为数组格式
  scenePropDurations.forEach((duration, prop) => {
    durationByProp.push({ prop, duration });
  });
  
  return {
    dialogue: parsed.lengthDialogue || 0,
    action: parsed.lengthAction || 0,
    total: (parsed.lengthDialogue || 0) + (parsed.lengthAction || 0),
    lengthchart_action: actionChart,
    lengthchart_dialogue: dialogueChart,
    durationBySceneProp: durationByProp,
    scenes,
    monologues,
  };
}

/**
 * 创建完整的统计数据对象
 * @param parsed 解析后的 Fountain 数据
 */
export function createStatistics(parsed: ParsedOutput) {
  return {
    characterStats: createCharacterStatistics(parsed),
    sceneStats: createSceneStatistics(parsed),
    locationStats: createLocationStatistics(parsed),
    durationStats: createDurationStatistics(parsed),
  };
}
