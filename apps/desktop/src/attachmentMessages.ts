const keys = ["attachments", "addAttachment", "saveAttachment", "removeAttachment", "attachmentLimits", "attachmentsShared", "invalidAttachment"];
const rows: Record<string, string[]> = {
  en: ["Attachments", "Add file", "Save as…", "Remove", "Up to 16 files, 1 MiB per file and 4 MiB per entry. Removed files remain in history.", "Sharing includes all attachments. Recipients can save their own copies.", "Invalid attachment or file name."],
  ru: ["Вложения", "Добавить файл", "Сохранить как…", "Убрать", "До 16 файлов, 1 МиБ на файл и 4 МиБ на запись. Удалённые файлы остаются в истории.", "Общий доступ включает все вложения. Получатель может сохранить свою копию файлов.", "Некорректное вложение или имя файла."],
  es: ["Adjuntos", "Añadir archivo", "Guardar como…", "Quitar", "Hasta 16 archivos, 1 MiB por archivo y 4 MiB por entrada. Los archivos eliminados permanecen en el historial.", "Al compartir se incluyen todos los adjuntos. El destinatario puede guardar copias.", "Adjunto o nombre de archivo no válido."],
  fr: ["Pièces jointes", "Ajouter un fichier", "Enregistrer sous…", "Retirer", "16 fichiers maximum, 1 Mio par fichier et 4 Mio par entrée. Les fichiers retirés restent dans l’historique.", "Le partage inclut toutes les pièces jointes. Le destinataire peut en conserver des copies.", "Pièce jointe ou nom de fichier invalide."],
  de: ["Anhänge", "Datei hinzufügen", "Speichern unter…", "Entfernen", "Bis zu 16 Dateien, 1 MiB pro Datei und 4 MiB pro Eintrag. Entfernte Dateien bleiben im Verlauf.", "Alle Anhänge werden geteilt. Empfänger können eigene Kopien speichern.", "Ungültiger Anhang oder Dateiname."],
  pt: ["Anexos", "Adicionar ficheiro", "Guardar como…", "Remover", "Até 16 ficheiros, 1 MiB por ficheiro e 4 MiB por entrada. Os ficheiros removidos permanecem no histórico.", "A partilha inclui todos os anexos. O destinatário pode guardar cópias.", "Anexo ou nome de ficheiro inválido."],
  "zh-Hans": ["附件", "添加文件", "另存为…", "移除", "最多16个文件，每个1 MiB，每条记录共4 MiB。移除的文件仍保留在历史记录中。", "共享包括所有附件。接收者可以保存副本。", "附件或文件名无效。"],
  "zh-Hant": ["附件", "新增檔案", "另存新檔…", "移除", "最多16個檔案，每個1 MiB，每筆記錄共4 MiB。移除的檔案仍保留在歷史記錄中。", "共享包括所有附件。接收者可以儲存副本。", "附件或檔名無效。"],
  ja: ["添付ファイル", "ファイルを追加", "名前を付けて保存…", "削除", "最大16ファイル、各1 MiB、項目全体で4 MiB。削除したファイルは履歴に残ります。", "共有にはすべての添付ファイルが含まれます。受信者はコピーを保存できます。", "添付ファイルまたはファイル名が無効です。"],
  hi: ["संलग्न फ़ाइलें", "फ़ाइल जोड़ें", "इस रूप में सहेजें…", "हटाएँ", "अधिकतम 16 फ़ाइलें, प्रति फ़ाइल 1 MiB और प्रति प्रविष्टि 4 MiB। हटाई गई फ़ाइलें इतिहास में रहती हैं।", "साझा करने पर सभी संलग्न फ़ाइलें शामिल होती हैं। प्राप्तकर्ता प्रतियाँ सहेज सकता है।", "अमान्य संलग्न फ़ाइल या फ़ाइल नाम।"],
  ar: ["المرفقات", "إضافة ملف", "حفظ باسم…", "إزالة", "حتى 16 ملفًا، 1 MiB لكل ملف و4 MiB لكل سجل. تبقى الملفات المحذوفة في المحفوظات.", "تشمل المشاركة جميع المرفقات. يمكن للمستلم حفظ نسخ منها.", "مرفق أو اسم ملف غير صالح."],
};
export const attachmentMessages = Object.fromEntries(Object.entries(rows).map(([language, values]) =>
  [language, Object.fromEntries(keys.map((key, i) => [`ui.${key}`, values[i]]))]));
