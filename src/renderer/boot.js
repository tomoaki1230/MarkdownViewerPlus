// 起動用の小さなスクリプト（<head> で同期実行し、最初の描画より前に動く）
// アプリ本体（app.bundle.js）の読み込みを待たずに、選択中のカラーテーマの色で最初の描画をするため。
// テーマの設定は main が URL のクエリ（theme / light / dark）で渡す。
import { findTheme, themeCssVars } from '../shared/themes.js';

const params = new URLSearchParams(location.search);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const theme = findTheme(dark ? 'dark' : 'light', params.get(dark ? 'dark' : 'light'));
const root = document.documentElement;
for (const [name, value] of Object.entries(themeCssVars(theme))) root.style.setProperty(name, value);
// ツールバーの明暗ボタンのアイコン（system / light / dark）
root.dataset.theme = params.get('theme') ?? 'system';
