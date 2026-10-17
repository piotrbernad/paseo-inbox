import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { inboxSettings } from "../shared/rpc.ts";

export function InboxSettings() {
  const settings = useSettings(inboxSettings);
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Inbox">
        <SettingsCard>
          <SettingsRow
            label={settings.status === "loading" ? "Loading…" : "Could not load the settings"}
            error={"error" in settings ? settings.error : null}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const value = draft ?? settings.values.configPath;
  return (
    <>
      <SettingsSection title="Config file">
        <SettingsCard>
          <SettingsInput
            label="Path on this host"
            hint="Empty uses PASEO_INBOX_CONFIG, else ~/.paseo/inbox.json."
            placeholder="~/.paseo/inbox.json"
            initialValue={settings.values.configPath}
            onChangeText={setDraft}
            error={settings.saveError ?? null}
          />
          <SettingsAction
            label="Save the path"
            actionLabel={settings.saving ? "Saving…" : "Save"}
            disabled={settings.saving || value === settings.values.configPath}
            onPress={() => {
              void settings
                .save({ ...settings.values, configPath: value.trim() }, settings.revision)
                .then((ok) => ok && setDraft(null));
            }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsCard>
          <SettingsSwitch
            label="Notify me about new questions"
            hint="A push to your phone when you have not used Paseo for 3 minutes, otherwise an in-app notification."
            value={settings.values.notify}
            disabled={settings.saving}
            onValueChange={(notify) => {
              void settings.save({ ...settings.values, notify }, settings.revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
