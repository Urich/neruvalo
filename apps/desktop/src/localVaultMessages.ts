// Kept together so the local vault flows have the same keys in every catalog.
const en = {
  localVault: "Local vault",
  createLocalVault: "Create local vault",
  restoreLocalBackup: "Restore from backup",
  exportLocalBackup: "Save encrypted backup",
  importLocalVault: "Import local vault",
  connectLocalVault: "Connect to a server",
  localVaultDescription: "Your encrypted vault stays on this device. No server, email or internet connection is needed.",
  connectLocalVaultHelp: "Sign in or create a server account. You will then confirm the import of your local vault.",
  localImportHelp: "Add all local entries, folders, archived items and history to this account. Existing server entries are kept. The original local vault remains available. Enter its password to confirm.",
  localBackupHelp: "The backup is encrypted with your local master password. Keep the file and password safe. Restoring creates a separate vault.",
  vaultName: "Vault name",
  localMasterPassword: "Local master password",
  confirmMasterPassword: "Confirm master password",
  backupSaved: "Encrypted backup saved.",
  localImportComplete: "Import verified. The local original has been kept.",
  localVaultReady: "Local vault is ready.",
};
type Messages = Record<keyof typeof en, string>;
const ru: Messages = {
  localVault: "Локальное хранилище", createLocalVault: "Создать локальное хранилище",
  restoreLocalBackup: "Восстановить из резервной копии", exportLocalBackup: "Сохранить зашифрованную копию",
  importLocalVault: "Перенести локальное хранилище", connectLocalVault: "Подключить к серверу",
  localVaultDescription: "Зашифрованное хранилище остаётся на этом устройстве. Сервер, email и подключение к интернету не нужны.",
  connectLocalVaultHelp: "Войдите в учётную запись на сервере или создайте новую. Затем подтвердите перенос локального хранилища.",
  localImportHelp: "Все локальные записи, папки, архив и история будут добавлены в эту учётную запись. Существующие записи на сервере и локальный оригинал сохранятся. Для подтверждения введите пароль локального хранилища.",
  localBackupHelp: "Копия зашифрована мастер-паролем локального хранилища. Сохраните файл и пароль. При восстановлении создаётся отдельное хранилище.",
  vaultName: "Название хранилища", localMasterPassword: "Мастер-пароль локального хранилища",
  confirmMasterPassword: "Повторите мастер-пароль", backupSaved: "Зашифрованная резервная копия сохранена.",
  localImportComplete: "Перенос проверен. Локальный оригинал сохранён.", localVaultReady: "Локальное хранилище готово.",
};
const es: Messages = {
  localVault: "Bóveda local", createLocalVault: "Crear bóveda local", restoreLocalBackup: "Restaurar copia de seguridad",
  exportLocalBackup: "Guardar copia cifrada", importLocalVault: "Importar bóveda local", connectLocalVault: "Conectar a un servidor",
  localVaultDescription: "La bóveda cifrada permanece en este dispositivo. No necesita servidor, correo ni internet.",
  connectLocalVaultHelp: "Inicia sesión o crea una cuenta en el servidor. Después confirmarás la importación de la bóveda local.",
  localImportHelp: "Añade entradas, carpetas, archivo e historial locales a esta cuenta. Se conservan las entradas del servidor y la bóveda local original. Confirma con su contraseña.",
  localBackupHelp: "La copia se cifra con la contraseña maestra local. Conserva el archivo y la contraseña. La restauración crea una bóveda independiente.",
  vaultName: "Nombre de la bóveda", localMasterPassword: "Contraseña maestra local", confirmMasterPassword: "Confirmar contraseña maestra",
  backupSaved: "Copia cifrada guardada.", localImportComplete: "Importación verificada. Se conserva el original local.", localVaultReady: "Bóveda local lista.",
};
const fr: Messages = {
  localVault: "Coffre local", createLocalVault: "Créer un coffre local", restoreLocalBackup: "Restaurer une sauvegarde",
  exportLocalBackup: "Enregistrer une sauvegarde chiffrée", importLocalVault: "Importer un coffre local", connectLocalVault: "Se connecter à un serveur",
  localVaultDescription: "Le coffre chiffré reste sur cet appareil. Aucun serveur, e-mail ou accès internet n’est nécessaire.",
  connectLocalVaultHelp: "Connectez-vous ou créez un compte serveur. Vous confirmerez ensuite l’importation du coffre local.",
  localImportHelp: "Ajoute les entrées, dossiers, archives et historiques locaux à ce compte. Les entrées du serveur et le coffre local original sont conservés. Confirmez avec son mot de passe.",
  localBackupHelp: "La sauvegarde utilise le mot de passe maître local. Conservez le fichier et le mot de passe. La restauration crée un coffre distinct.",
  vaultName: "Nom du coffre", localMasterPassword: "Mot de passe maître local", confirmMasterPassword: "Confirmer le mot de passe maître",
  backupSaved: "Sauvegarde chiffrée enregistrée.", localImportComplete: "Importation vérifiée. L’original local est conservé.", localVaultReady: "Le coffre local est prêt.",
};
const de: Messages = {
  localVault: "Lokaler Tresor", createLocalVault: "Lokalen Tresor erstellen", restoreLocalBackup: "Sicherung wiederherstellen",
  exportLocalBackup: "Verschlüsselte Sicherung speichern", importLocalVault: "Lokalen Tresor importieren", connectLocalVault: "Mit Server verbinden",
  localVaultDescription: "Der verschlüsselte Tresor bleibt auf diesem Gerät. Server, E-Mail und Internet sind nicht erforderlich.",
  connectLocalVaultHelp: "Melden Sie sich am Server an oder erstellen Sie ein Konto. Bestätigen Sie anschließend den Import des lokalen Tresors.",
  localImportHelp: "Lokale Einträge, Ordner, Archiv und Verlauf werden diesem Konto hinzugefügt. Vorhandene Servereinträge und der lokale Tresor bleiben erhalten. Bestätigen Sie mit dessen Passwort.",
  localBackupHelp: "Die Sicherung wird mit dem lokalen Masterpasswort verschlüsselt. Bewahren Sie Datei und Passwort auf. Die Wiederherstellung erstellt einen separaten Tresor.",
  vaultName: "Tresorname", localMasterPassword: "Lokales Masterpasswort", confirmMasterPassword: "Masterpasswort bestätigen",
  backupSaved: "Verschlüsselte Sicherung gespeichert.", localImportComplete: "Import geprüft. Das lokale Original bleibt erhalten.", localVaultReady: "Lokaler Tresor ist bereit.",
};
const pt: Messages = {
  localVault: "Cofre local", createLocalVault: "Criar cofre local", restoreLocalBackup: "Restaurar cópia de segurança",
  exportLocalBackup: "Guardar cópia encriptada", importLocalVault: "Importar cofre local", connectLocalVault: "Ligar a um servidor",
  localVaultDescription: "O cofre encriptado fica neste dispositivo. Não precisa de servidor, email nem internet.",
  connectLocalVaultHelp: "Entre ou crie uma conta no servidor. Depois confirme a importação do cofre local.",
  localImportHelp: "Adiciona os registos, pastas, arquivo e histórico locais a esta conta. Os registos do servidor e o cofre local original são preservados. Confirme com a palavra-passe local.",
  localBackupHelp: "A cópia usa a palavra-passe mestra local. Guarde o ficheiro e a palavra-passe. O restauro cria um cofre separado.",
  vaultName: "Nome do cofre", localMasterPassword: "Palavra-passe mestra local", confirmMasterPassword: "Confirmar palavra-passe mestra",
  backupSaved: "Cópia encriptada guardada.", localImportComplete: "Importação verificada. O original local foi preservado.", localVaultReady: "Cofre local pronto.",
};
const hans: Messages = {
  localVault: "本地保险库", createLocalVault: "创建本地保险库", restoreLocalBackup: "从备份恢复", exportLocalBackup: "保存加密备份",
  importLocalVault: "导入本地保险库", connectLocalVault: "连接服务器", localVaultDescription: "加密保险库保存在此设备上，无需服务器、电子邮件或网络连接。",
  connectLocalVaultHelp: "登录或创建服务器账户，然后确认导入本地保险库。", localImportHelp: "将本地条目、文件夹、归档和历史记录添加到此账户。现有服务器条目和本地原件均会保留。请输入本地主密码确认。",
  localBackupHelp: "备份使用本地主密码加密。请妥善保存文件和密码。恢复时将创建独立的保险库。", vaultName: "保险库名称", localMasterPassword: "本地主密码", confirmMasterPassword: "确认主密码",
  backupSaved: "已保存加密备份。", localImportComplete: "导入已验证，本地原件已保留。", localVaultReady: "本地保险库已就绪。",
};
const hant: Messages = {
  localVault: "本機保險庫", createLocalVault: "建立本機保險庫", restoreLocalBackup: "從備份還原", exportLocalBackup: "儲存加密備份",
  importLocalVault: "匯入本機保險庫", connectLocalVault: "連線至伺服器", localVaultDescription: "加密保險庫儲存在此裝置上，不需要伺服器、電子郵件或網路連線。",
  connectLocalVaultHelp: "登入或建立伺服器帳戶，然後確認匯入本機保險庫。", localImportHelp: "將本機項目、資料夾、封存和歷程記錄加入此帳戶。現有伺服器項目和本機原件都會保留。請輸入本機主密碼確認。",
  localBackupHelp: "備份使用本機主密碼加密。請妥善保存檔案和密碼。還原時會建立獨立的保險庫。", vaultName: "保險庫名稱", localMasterPassword: "本機主密碼", confirmMasterPassword: "確認主密碼",
  backupSaved: "已儲存加密備份。", localImportComplete: "匯入已驗證，本機原件已保留。", localVaultReady: "本機保險庫已就緒。",
};
const ja: Messages = {
  localVault: "ローカル保管庫", createLocalVault: "ローカル保管庫を作成", restoreLocalBackup: "バックアップから復元", exportLocalBackup: "暗号化バックアップを保存",
  importLocalVault: "ローカル保管庫を取り込む", connectLocalVault: "サーバーに接続", localVaultDescription: "暗号化された保管庫はこの端末に保存されます。サーバー、メール、インターネット接続は不要です。",
  connectLocalVaultHelp: "サーバーのアカウントにログインするか、新しく作成してください。その後、ローカル保管庫の取り込みを確認します。", localImportHelp: "ローカルの項目、フォルダー、アーカイブ、履歴をこのアカウントに追加します。サーバーの既存項目とローカルの原本は保持されます。ローカルのパスワードで確認してください。",
  localBackupHelp: "バックアップはローカルのマスターパスワードで暗号化されます。ファイルとパスワードを保管してください。復元時は別の保管庫を作成します。", vaultName: "保管庫名", localMasterPassword: "ローカルのマスターパスワード", confirmMasterPassword: "マスターパスワードを確認",
  backupSaved: "暗号化バックアップを保存しました。", localImportComplete: "取り込みを確認しました。ローカルの原本は保持されています。", localVaultReady: "ローカル保管庫の準備ができました。",
};
const hi: Messages = {
  localVault: "स्थानीय तिजोरी", createLocalVault: "स्थानीय तिजोरी बनाएँ", restoreLocalBackup: "बैकअप से पुनर्स्थापित करें", exportLocalBackup: "एन्क्रिप्टेड बैकअप सहेजें",
  importLocalVault: "स्थानीय तिजोरी आयात करें", connectLocalVault: "सर्वर से कनेक्ट करें", localVaultDescription: "एन्क्रिप्टेड तिजोरी इसी डिवाइस पर रहती है। सर्वर, ईमेल या इंटरनेट की आवश्यकता नहीं है।",
  connectLocalVaultHelp: "सर्वर खाते में साइन इन करें या नया खाता बनाएँ। फिर स्थानीय तिजोरी के आयात की पुष्टि करें।", localImportHelp: "स्थानीय प्रविष्टियाँ, फ़ोल्डर, संग्रह और इतिहास इस खाते में जोड़ें। सर्वर की मौजूदा प्रविष्टियाँ और स्थानीय मूल सुरक्षित रहेंगे। पुष्टि के लिए स्थानीय पासवर्ड दर्ज करें।",
  localBackupHelp: "बैकअप स्थानीय मास्टर पासवर्ड से एन्क्रिप्ट होता है। फ़ाइल और पासवर्ड सुरक्षित रखें। पुनर्स्थापना एक अलग तिजोरी बनाती है।", vaultName: "तिजोरी का नाम", localMasterPassword: "स्थानीय मास्टर पासवर्ड", confirmMasterPassword: "मास्टर पासवर्ड की पुष्टि करें",
  backupSaved: "एन्क्रिप्टेड बैकअप सहेजा गया।", localImportComplete: "आयात सत्यापित है। स्थानीय मूल सुरक्षित है।", localVaultReady: "स्थानीय तिजोरी तैयार है।",
};
const ar: Messages = {
  localVault: "خزنة محلية", createLocalVault: "إنشاء خزنة محلية", restoreLocalBackup: "استعادة نسخة احتياطية", exportLocalBackup: "حفظ نسخة احتياطية مشفرة",
  importLocalVault: "استيراد خزنة محلية", connectLocalVault: "الاتصال بخادم", localVaultDescription: "تبقى الخزنة المشفرة على هذا الجهاز. لا حاجة إلى خادم أو بريد إلكتروني أو اتصال بالإنترنت.",
  connectLocalVaultHelp: "سجّل الدخول إلى حساب الخادم أو أنشئ حسابًا. ثم أكّد استيراد الخزنة المحلية.", localImportHelp: "إضافة الإدخالات والمجلدات والأرشيف والسجل المحلي إلى هذا الحساب. تُحفظ إدخالات الخادم الحالية والخزنة المحلية الأصلية. أدخل كلمة مرورها للتأكيد.",
  localBackupHelp: "تُشفّر النسخة بكلمة المرور الرئيسية المحلية. احتفظ بالملف وكلمة المرور. تنشئ الاستعادة خزنة منفصلة.", vaultName: "اسم الخزنة", localMasterPassword: "كلمة المرور الرئيسية المحلية", confirmMasterPassword: "تأكيد كلمة المرور الرئيسية",
  backupSaved: "حُفظت النسخة الاحتياطية المشفرة.", localImportComplete: "تم التحقق من الاستيراد والاحتفاظ بالأصل المحلي.", localVaultReady: "الخزنة المحلية جاهزة.",
};
export const localVaultMessages: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries({ en, ru, es, fr, de, pt, "zh-Hans": hans, "zh-Hant": hant, ja, hi, ar })
    .map(([language, messages]) => [language, Object.fromEntries(Object.entries(messages).map(([key, value]) => [`ui.${key}`, value]))]),
);
