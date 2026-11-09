import type { Parameter, ParameterGroup, Project } from '@l2s/editor-core';

/**
 * Parameter-list CSV in the column layout Cubism Editor uses for parameter lists:
 * GUID, type (PARAMETER_GROUP / PARAMETER), ID, name, group ID, min, default, max,
 * repeat, description, label colour (e.g. "RED:#903D34"). Columns are read by
 * position, so localized header rows (Korean / Japanese / English) all work.
 */
export const PARAMETER_CSV_HEADER = ['GUID', '유형', 'ID', '이름', '그룹', '최소값', '기준값', '최대값', '반복', '설명', '라벨색'];

/** The project's default parameter list (supplied with the default character). */
export const DEFAULT_PARAMETER_CSV = "GUID,유형,ID,이름,그룹,최소값,기준값,최대값,반복,설명,라벨색\nfb7f39df-7d87-447d-ae86-66929298e8ee,PARAMETER_GROUP,ParamGroup,XYZ,,,,,,,RED:#903D34\n20bb9ab6-d4bd-4020-ae0b-f74514f06863,PARAMETER_GROUP,ParamGroup2,눈,,,,,,,ORANGE:#7D4B08\n4079d9ca-6836-4209-8705-dd0b1ff3ac87,PARAMETER_GROUP,ParamGroup3,눈썹,,,,,,,YELLOW:#707000\n84a3c06b-91b4-4af6-8e32-026e10b3e469,PARAMETER_GROUP,ParamGroup4,입,,,,,,,GREEN:#2E6330\nbeab0034-540d-4a2e-a78a-c53f7dca6389,PARAMETER_GROUP,ParamGroup5,몸,,,,,,,BLUE:#415979\n54aaf680-f141-4e7e-a3e8-7b31bf9ca579,PARAMETER_GROUP,ParamGroup6,물리,,,,,,,PURPLE:#644683\n40435382-db3b-4074-ab8e-80b45f24202f,PARAMETER,ParamAngleX,각도 X,ParamGroup,-30.0,0.0,30.0,false,+로 화면의 오른쪽을 향하기,\n60cf3686-ab6a-4050-a273-c8322b56d9b1,PARAMETER,ParamAngleY,각도 Y,ParamGroup,-30.0,0.0,30.0,false,+로 화면 상단을 향하기,\n3d02668f-0860-4c5e-9e27-2ebd9e690e6c,PARAMETER,ParamAngleZ,각도 Z,ParamGroup,-30.0,0.0,30.0,false,+로 화면의 오른쪽을 향하기,\n04a24f48-1516-4307-bcd3-a2e86c78bac2,PARAMETER,ParamEyeLOpen,왼쪽 눈 깜빡임,ParamGroup2,0.0,1.0,1.0,false,+로 눈을 뜨기,\n8327485e-ed5b-49fb-bab1-6ff8dc4bfb11,PARAMETER,ParamEyeLSmile,왼쪽 눈 미소,ParamGroup2,0.0,0.0,1.0,false,+로 웃는 눈,\n4bbf19fb-f5b6-440d-a4cc-ccb85d561ea5,PARAMETER,ParamEyeROpen,오른쪽 눈 깜빡임,ParamGroup2,0.0,1.0,1.0,false,+로 눈을 뜨기,\n46537ed5-5232-4081-b83c-b31c955b51e0,PARAMETER,ParamEyeRSmile,오른쪽 눈 미소,ParamGroup2,0.0,0.0,1.0,false,+로 웃는 눈,\nc700aa55-ff31-432c-b10b-64772d61e877,PARAMETER,ParamEyeBallX,눈 X,ParamGroup2,-1.0,0.0,1.0,false,+로 오른쪽 보기,\nd2b694fd-4ef2-480b-a9f5-62400f87abc2,PARAMETER,ParamEyeBallY,눈 Y,ParamGroup2,-1.0,0.0,1.0,false,+로 위를 보기,\n09621497-07cc-41d0-ba1f-149f2b30d237,PARAMETER,ParamBrowLY,왼쪽 눈썹 위아래로,ParamGroup3,-1.0,0.0,1.0,false,+로 눈썹을 올리기,\n8738ce30-683a-4c7e-871f-275d43c15156,PARAMETER,ParamBrowLForm,왼쪽 눈썹 변형,ParamGroup3,-1.0,0.0,1.0,false,-로 눈썹을 화나게,\n9c8e3bb9-e68d-4dc0-bd46-e88858709821,PARAMETER,ParamBrowRY,오른쪽 눈썹 위아래로,ParamGroup3,-1.0,0.0,1.0,false,+로 눈썹을 올리기,\n9a1170c3-e81c-415d-b239-21a25f6dc26f,PARAMETER,ParamBrowRForm,오른쪽 눈썹 변형,ParamGroup3,-1.0,0.0,1.0,false,-로 눈썹을 화나게,\n9e396881-3ae5-4a33-b896-aff0be7ed7eb,PARAMETER,ParamMouthForm,입 변형,ParamGroup4,-1.0,0.0,1.0,false,\"+로 웃는 입, -로 화가난 입\",\n8e73bbb1-dc2e-42bf-a636-d0e33e984886,PARAMETER,ParamMouthOpenY,입 여닫기,ParamGroup4,0.0,0.0,1.0,false,+로 입을 열기,\nc5f13907-4501-4e26-af5e-fce8bba9be75,PARAMETER,ParamBodyAngleX,몸의 회전 X,ParamGroup5,-10.0,0.0,10.0,false,+로 화면의 오른쪽을 향하기,\ncc6904ff-ed9a-4292-ae64-99bbfe78a2f8,PARAMETER,ParamBodyAngleY,몸의 회전 Y,ParamGroup5,-10.0,0.0,10.0,false,+로 화면 위로 움직임,\n784c3ac9-83a4-4733-96f9-0c316bf674e1,PARAMETER,ParamBodyAngleZ,몸의 회전 Z,ParamGroup5,-10.0,0.0,10.0,false,+로 화면의 오른쪽으로 기울이기,\n55a1cab4-5e9b-4549-b47d-1c47972cdb20,PARAMETER,ParamBreath,호흡,ParamGroup5,0.0,0.0,1.0,false,+로 숨 들이마시기,\n";

export interface ParameterCsv {
  groups: ParameterGroup[];
  parameters: Parameter[];
  warnings: string[];
}

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF/LF. */
function rows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], f = '', q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x !== '')) out.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x !== '')) out.push(row);
  return out;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s));

export function parseParameterCsv(text: string): ParameterCsv {
  const all = rows(text);
  const warnings: string[] = [];
  const body = all.filter((r) => /^(PARAMETER|PARAMETER_GROUP)$/.test((r[1] ?? '').trim()));
  if (!body.length) throw new Error('No PARAMETER rows found. Expected the Cubism parameter-list CSV layout (GUID, type, ID, name, group, min, default, max, repeat, description, label colour).');
  const groups: ParameterGroup[] = [];
  const parameters: Parameter[] = [];
  for (const r of body) {
    const [guid, type, id, name, group, min, def, max, repeat, description, color] = r.map((x) => x.trim());
    if (!id) { warnings.push('Skipped a row without an ID.'); continue; }
    if (type === 'PARAMETER_GROUP') {
      groups.push({ id, name: name || id, ...(color ? { color } : {}), ...(guid ? { guid } : {}) });
      continue;
    }
    const p: Parameter = { id, name: name || id, min: num(min), max: num(max), default: num(def) };
    if (![p.min, p.max, p.default].every(Number.isFinite) || !(p.min < p.max) || p.default < p.min || p.default > p.max) {
      warnings.push(`${id}: invalid range ${min} / ${def} / ${max}; skipped.`);
      continue;
    }
    if (repeat?.toLowerCase() === 'true') p.repeat = true;
    if (group) p.groupId = group;
    if (description) p.description = description;
    if (guid) p.guid = guid;
    parameters.push(p);
  }
  for (const p of parameters) {
    if (p.groupId && !groups.some((g) => g.id === p.groupId)) { warnings.push(`${p.id}: unknown group ${p.groupId}; left ungrouped.`); delete p.groupId; }
  }
  return { groups, parameters, warnings };
}

const cell = (v: string | number | undefined) => {
  const s = v === undefined ? '' : typeof v === 'number' ? v.toFixed(1).replace(/\.0$/, '.0') : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmt = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

/** Writes the same layout (Korean header), groups first, then parameters in project order. */
export function toParameterCsv(project: Pick<Project, 'parameters' | 'parameterGroups'>): string {
  const lines = [PARAMETER_CSV_HEADER.join(',')];
  for (const g of project.parameterGroups) lines.push([g.guid ?? uuid(), 'PARAMETER_GROUP', g.id, g.name, '', '', '', '', '', '', g.color ?? ''].map(cell).join(','));
  for (const p of project.parameters) {
    lines.push([p.guid ?? uuid(), 'PARAMETER', p.id, p.name, p.groupId ?? '', fmt(p.min), fmt(p.default), fmt(p.max), p.repeat ? 'true' : 'false', p.description ?? '', ''].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

const DEFAULT_LIST = parseParameterCsv(DEFAULT_PARAMETER_CSV);
/** Default parameter groups (from {@link DEFAULT_PARAMETER_CSV}). */
export const STANDARD_PARAMETER_GROUPS: readonly ParameterGroup[] = DEFAULT_LIST.groups;
/** Default parameters (from {@link DEFAULT_PARAMETER_CSV}). */
export const DEFAULT_PARAMETERS: readonly Parameter[] = DEFAULT_LIST.parameters;
