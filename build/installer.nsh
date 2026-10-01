; インストーラ（NSIS）への追加処理。electron-builder が package.json の nsis.include で読み込む
;
; customInstall は、ファイルの関連付けの登録（registerFileAssociations）の後に実行される。
; electron-builder の標準の処理は、関連付けを書き込む前（ショートカットを作るとき）にしかエクスプローラーへ
; 通知しないため、関連付けたファイルのアイコンがすぐに変わらないことがある。登録の後に改めて通知する。
;   SHCNE_ASSOCCHANGED = 0x08000000（関連付けが変わった）、SHCNF_FLUSH = 0x1000（処理が終わるまで待つ）
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend
