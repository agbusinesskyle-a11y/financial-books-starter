-- Forms, stage F1: each person's last save choice per form (Save and close, Save and new, …) becomes their main button.
CREATE TABLE form_save_pref (
  org_id bigint NOT NULL REFERENCES org (org_id),
  user_key text NOT NULL,
  form_type text NOT NULL,
  choice text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_key, form_type)
);
