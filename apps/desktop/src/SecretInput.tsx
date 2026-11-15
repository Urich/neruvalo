import { InputHTMLAttributes, TextareaHTMLAttributes, useId, useState } from "react";
import { Icon } from "./Icon";
import { useI18n } from "./i18n";

// Keep the visibility control inside the field so it stays on the right at every width.
export function SecretInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const label = t(visible ? "ui.hide" : "ui.show");
  return <span className="secret-field">
    <input {...props} id={id} type={visible ? "text" : "password"} />
    <button type="button" className="secret-toggle" aria-label={label} title={label} aria-pressed={visible} aria-controls={id} disabled={props.disabled}
      onClick={() => setVisible(value => !value)}><Icon name={visible ? "eye_off" : "eye"} /></button>
  </span>;
}

export function SecretTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const label = t(visible ? "ui.hide" : "ui.show");
  return <span className="secret-field secret-field-multiline">
    <textarea {...props} id={id} className={`${props.className ?? ""} ${visible ? "" : "secret-masked"}`} />
    <button type="button" className="secret-toggle" aria-label={label} title={label} aria-pressed={visible} aria-controls={id} disabled={props.disabled}
      onClick={() => setVisible(value => !value)}><Icon name={visible ? "eye_off" : "eye"} /></button>
  </span>;
}
