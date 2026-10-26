// Mermaid（図）の遅延ロード用バンドルの入口。図のある文書を開いたときだけ読み込む（mermaid.bundle.js）
import mermaid from 'mermaid';

window.mermaid = mermaid;
