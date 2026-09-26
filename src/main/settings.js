// 利用者設定の保存（userData/settings.json）
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_THEME_ID, isThemeId } from '../shared/themes.js';
import { MAX_RECENT } from './recent.js';

export const THEMES = ['system', 'light', 'dark'];
// theme: 明暗の選び方（system / light / dark）、lightTheme / darkTheme: それぞれで使うカラーテーマの ID
// resident: タスクトレイに常駐するか（既定は常駐しない）
// disableGpu: GPU を使わずに起動するか（GPU 処理が異常終了したときに自動でオンにする）
// autoReload: ファイルが外部で変更されたら自動で読み直すか（既定はオン）
// breaks: プレビューで改行だけでも改行する（行末の半角スペース 2 つが無くても）か
// previewWidth: プレビューの表示幅（narrow / standard / wide / full）
export const PREVIEW_WIDTHS = ['narrow', 'standard', 'wide', 'full'];
const DEFAULTS = {
  theme: 'system',
  lightTheme: DEFAULT_THEME_ID,
  darkTheme: DEFAULT_THEME_ID,
  resident: false,
  disableGpu: false,
  autoReload: true,
  breaks: false,
  previewWidth: 'standard',
  recent: [],
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const settings = { ...DEFAULTS, ...data };
    if (!THEMES.includes(settings.theme)) settings.theme = DEFAULTS.theme;
    if (!isThemeId('light', settings.lightTheme)) settings.lightTheme = DEFAULT_THEME_ID;
    if (!isThemeId('dark', settings.darkTheme)) settings.darkTheme = DEFAULT_THEME_ID;
    for (const key of ['resident', 'disableGpu', 'autoReload', 'breaks']) {
      if (typeof settings[key] !== 'boolean') settings[key] = DEFAULTS[key];
    }
    if (!PREVIEW_WIDTHS.includes(settings.previewWidth)) settings.previewWidth = DEFAULTS.previewWidth;
    settings.recent = Array.isArray(settings.recent)
      ? settings.recent.filter((p) => typeof p === 'string').slice(0, MAX_RECENT)
      : [];
    return settings;
  } catch {
    // 初回起動・破損時は既定値
    return { ...DEFAULTS, recent: [] };
  }
}

export function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('設定を保存できませんでした:', err.message);
  }
}
