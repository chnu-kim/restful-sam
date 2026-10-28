// 기록 요약 이미지(이번 달·전체). 모달에 보이는 캔버스를 그대로 PNG로 저장해 화면과 파일이 어긋나지 않게 한다.
// 칸 판정은 달력과 같은 calendar.js 함수를 쓰고, 색은 페이지의 CSS 변수(현재 테마)에서 읽어 온다
import {
  DOW, addDays, addMonths, countDays, dayMinutes, dayOfWeek, dayStatus, fillPercent, firstMonth, makeContext, monthDays, todayKst,
} from './calendar.js';

export const SUMMARY_WIDTH = 1080;
const PAD = 64;
const PANEL_PAD = 32;
const MONTH_GAP_X = 40;
const MONTH_GAP_Y = 40;
const CELL_GAP = 6;
const MONTH_LABEL = 30;
const DOW_ROW = 28;
const TILE_H = 116;
const LEGEND_H = 24;
const FOOTER_H = 22;
const FONT = "'IBM Plex Sans KR', system-ui, sans-serif";
const font = (weight, size) => `${weight} ${size}px ${FONT}`;

// 페이지 CSS 변수 이름. 캔버스에는 변수를 쓸 수 없어 그릴 때 값을 읽어 넘긴다
export const PALETTE_VARS = {
  bg: '--bg', surface: '--surface', text: '--text', muted: '--muted', line: '--line',
  onText: '--on-text', onSoft: '--on-soft', onFill: '--on-fill', offText: '--off-text', offSoft: '--off-soft', pending: '--pending', none: '--none',
};

export function readPalette(style) {
  return Object.fromEntries(Object.entries(PALETTE_VARS).map(([k, v]) => [k, style.getPropertyValue(v).trim()]));
}

const dotDate = (d) => d.replaceAll('-', '.');

// 요약 범위. 이번 달은 오늘이 속한 달 하나, 전체는 기록이 있는 모든 달
export const SCOPES = {
  month: { title: (ym) => `${Number(ym.slice(5))}월 기록`, label: '이번 달 요약', file: (today) => today.slice(0, 7) },
  all: { title: () => '전체 기록', label: '전체 기록 요약', file: (today) => `전체-${today}` },
};

// 그릴 내용. 일수는 시작일(기록 시작일, 이번 달이면 그달 1일과 비교해 늦은 쪽)부터 오늘까지로 월 통계와 같은 규칙,
// 달력은 이번 달이면 그달만, 전체면 달력에서 넘길 수 있는 첫 달부터 이번 달까지
export function summaryView(data, now, scope = 'month') {
  const today = todayKst(now);
  const ym = today.slice(0, 7);
  const ctx = makeContext(data, today);
  const start = scope === 'month' && `${ym}-01` > data.since ? `${ym}-01` : data.since;
  const days = [];
  for (let d = start; d <= today; d = addDays(d, 1)) days.push(d);
  const months = [];
  for (let m = scope === 'month' ? ym : firstMonth(data); m <= ym; m = addMonths(m, 1)) {
    const md = monthDays(m);
    const [y, mo] = m.split('-').map(Number);
    months.push({
      label: `${y}년 ${mo}월`,
      cells: [
        ...Array.from({ length: dayOfWeek(md[0]) }, () => ({ status: 'blank', day: null, fill: null })),
        ...md.map((d) => {
          const status = dayStatus(d, ctx);
          // 달력처럼 지난 방송일만 방송 시간만큼 채운다 (오늘은 아직 끝나지 않았을 수 있다)
          const mins = status === 'on' && d < today ? dayMinutes(ctx.byDay.get(d)) : null;
          return { status, day: Number(d.slice(8)), fill: mins === null ? null : fillPercent(mins) };
        }),
      ],
    });
  }
  const s = SCOPES[scope];
  return {
    scope, today, title: s.title(ym), range: `${dotDate(start)} ~ ${dotDate(today)}`, days: days.length, ...countDays(ctx, days), months,
  };
}

// 스크린 리더용 설명과 저장 파일 이름
export const summaryLabel = (v) => `${SCOPES[v.scope].label}: ${v.range}, 방송 ${v.on}일, 휴방 ${v.off}일, 휴방률 ${v.offRate ?? '-'}%`;
export const summaryFileName = (v) => `삼덕이-휴방-요약-${SCOPES[v.scope].file(v.today)}.png`;

const TILES = (v) => [
  [`${v.on}일`, '방송한 날'],
  [`${v.off}일`, '휴방한 날'],
  [v.offRate === null ? '-' : `${v.offRate}%`, '휴방률'],
];
const LEGEND = [['on', '방송 (채운 높이: 방송 시간)'], ['off', '휴방'], ['unknown', '확인 전'], ['nodata', '기록 없음']];

// 캔버스 글꼴은 웹폰트 중 이미 받은 글자만 쓰므로, 그릴 글자를 미리 받아 둔다
export function summaryText(v, site) {
  return [
    '삼덕이 휴방 체크', v.title, `${v.range} (${v.days}일)`, site, ...DOW,
    ...TILES(v).flat(), ...LEGEND.map(([, t]) => t), ...v.months.map((m) => m.label), '0123456789',
  ].join('');
}

// 폰트 요청이 멈춰도 미리보기·저장이 막히지 않도록 이만큼만 기다린다
export const FONT_TIMEOUT_MS = 3000;

export async function loadFonts(fonts, text, timeout = FONT_TIMEOUT_MS) {
  if (!fonts) return;
  let timer;
  try {
    await Promise.race([
      Promise.all([400, 600, 700].map((w) => fonts.load(font(w, 20), text))),
      new Promise((resolve) => { timer = setTimeout(resolve, timeout); }),
    ]);
  } catch {
    // 폰트를 못 받으면 시스템 글꼴로 그린다
  } finally {
    clearTimeout(timer);
  }
}

function layout(v) {
  // 이번 달은 한 달을 폭 가득 크게 그린다. 전체는 달이 하나뿐이어도 칸이 커지지 않게 두 칸 폭을 유지한다
  const cols = v.scope === 'month' ? 1 : 2;
  const panelW = SUMMARY_WIDTH - PAD * 2;
  const monthW = (panelW - PANEL_PAD * 2 - MONTH_GAP_X * (cols - 1)) / cols;
  const cell = (monthW - CELL_GAP * 6) / 7;
  // 달마다 높이를 맞춰 줄을 가지런히 하되, 가장 긴 달의 주 수만큼만 잡는다
  const weeks = Math.max(...v.months.map((m) => Math.ceil(m.cells.length / 7)));
  const monthH = MONTH_LABEL + 16 + DOW_ROW + 8 + weeks * cell + (weeks - 1) * CELL_GAP;
  const rows = Math.ceil(v.months.length / cols);
  const panelY = PAD + 210 + TILE_H + 40;
  const panelH = PANEL_PAD * 2 + rows * monthH + (rows - 1) * MONTH_GAP_Y;
  const legendY = panelY + panelH + 28;
  return { cols, panelW, monthW, cell, monthH, panelY, panelH, legendY, height: legendY + LEGEND_H + 20 + FOOTER_H + PAD };
}

export const summaryHeight = (v) => layout(v).height;

// 달력 칸 하나. 페이지의 .day 상태별 모양을 따른다
function drawCell(g, p, c, x, y, s) {
  const r = s * 0.16;
  const box = () => {
    g.beginPath();
    g.roundRect(x, y, s, s, r);
  };
  if (c.status === 'blank') return;
  g.save();
  if (c.status === 'pending') {
    g.setLineDash([6, 4]);
    g.lineWidth = 2;
    g.strokeStyle = p.pending;
    g.beginPath();
    g.roundRect(x + 1, y + 1, s - 2, s - 2, r);
    g.stroke();
  } else if (c.status !== 'future') {
    box();
    g.clip();
    g.fillStyle = { on: p.onSoft, off: p.offSoft, unknown: 'transparent', nodata: p.none }[c.status];
    g.fillRect(x, y, s, s);
    if (c.fill !== null) {
      const h = (s * c.fill) / 100;
      g.fillStyle = p.onFill;
      g.fillRect(x, y + s - h, s, h);
    }
    if (c.status === 'unknown') {
      // 135° 빗금 (폭 6, 간격 12)
      g.strokeStyle = p.none;
      g.lineWidth = 6;
      g.beginPath();
      for (let k = 0; k < s * 2 + 17; k += 17) {
        g.moveTo(x + k, y);
        g.lineTo(x + k - s, y + s);
      }
      g.stroke();
    }
  }
  g.restore();
  g.fillStyle = c.status === 'nodata' || c.status === 'future' ? p.muted : p.text;
  // 칸이 커지면(이번 달) 날짜 글자도 같은 비율로 키운다
  const k = Math.max(1, s / 64);
  g.font = font(400, Math.round(17 * k));
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillText(String(c.day), x + 7 * k, y + 6 * k);
}

export function drawSummary(g, v, p, site) {
  const L = layout(v);
  const right = SUMMARY_WIDTH - PAD;
  g.fillStyle = p.bg;
  g.fillRect(0, 0, SUMMARY_WIDTH, L.height);
  g.textBaseline = 'top';
  g.textAlign = 'left';

  g.fillStyle = p.muted;
  g.font = font(600, 26);
  g.fillText('삼덕이 휴방 체크', PAD, PAD);
  g.fillStyle = p.text;
  g.font = font(700, 60);
  g.fillText(v.title, PAD, PAD + 44);
  g.fillStyle = p.muted;
  g.font = font(400, 26);
  g.fillText(`${v.range} (${v.days}일)`, PAD, PAD + 128);

  // 방송·휴방 일수 칸 (페이지의 .stat)
  const tileY = PAD + 210;
  const tileW = (L.panelW - 16 * 2) / 3;
  TILES(v).forEach(([value, label], i) => {
    const x = PAD + i * (tileW + 16);
    g.fillStyle = p.surface;
    g.strokeStyle = p.line;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x + 1, tileY + 1, tileW - 2, TILE_H - 2, 18);
    g.fill();
    g.stroke();
    g.fillStyle = [p.onText, p.offText, p.text][i];
    g.font = font(700, 44);
    g.fillText(value, x + 24, tileY + 18);
    g.fillStyle = p.muted;
    g.font = font(400, 22);
    g.fillText(label, x + 24, tileY + 74);
  });

  // 달력 (페이지의 .cal)
  g.fillStyle = p.surface;
  g.strokeStyle = p.line;
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(PAD + 1, L.panelY + 1, L.panelW - 2, L.panelH - 2, 24);
  g.fill();
  g.stroke();
  v.months.forEach((m, i) => {
    const mx = PAD + PANEL_PAD + (i % L.cols) * (L.monthW + MONTH_GAP_X);
    const my = L.panelY + PANEL_PAD + Math.floor(i / L.cols) * (L.monthH + MONTH_GAP_Y);
    g.fillStyle = p.text;
    g.font = font(700, 26);
    g.textAlign = 'left';
    g.fillText(m.label, mx, my);
    g.fillStyle = p.muted;
    g.font = font(400, Math.round(18 * Math.min(1.4, Math.max(1, L.cell / 64))));
    g.textAlign = 'center';
    DOW.forEach((d, j) => g.fillText(d, mx + j * (L.cell + CELL_GAP) + L.cell / 2, my + MONTH_LABEL + 16));
    const gy = my + MONTH_LABEL + 16 + DOW_ROW + 8;
    m.cells.forEach((c, j) => drawCell(g, p, c, mx + (j % 7) * (L.cell + CELL_GAP), gy + Math.floor(j / 7) * (L.cell + CELL_GAP), L.cell));
  });

  // 범례와 사이트 주소
  g.textAlign = 'left';
  g.font = font(400, 20);
  let lx = PAD;
  for (const [status, text] of LEGEND) {
    drawCell(g, p, { status, day: '', fill: status === 'on' ? 50 : null }, lx, L.legendY, LEGEND_H);
    g.fillStyle = p.muted;
    g.font = font(400, 20);
    g.fillText(text, lx + LEGEND_H + 8, L.legendY + 1);
    lx += LEGEND_H + 8 + g.measureText(text).width + 24;
  }
  g.textAlign = 'right';
  g.fillText(site, right, L.legendY + LEGEND_H + 20);
}
