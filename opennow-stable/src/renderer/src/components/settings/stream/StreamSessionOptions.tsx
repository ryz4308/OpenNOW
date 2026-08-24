import { type JSX } from "react";
import type { Settings } from "@shared/gfn";
import { useTranslation } from "../../../i18n";
import type { SettingsChangeHandler } from "./streamSettingsTypes";

interface StreamSessionOptionsProps {
  settings: Settings;
  handleChange: SettingsChangeHandler;
}

export function StreamSessionOptions({
  settings,
  handleChange,
}: StreamSessionOptionsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <>
      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label
            className="settings-label settings-label--wrap"
            htmlFor="settings-stream-enable-l4s"
          >
            <span className="settings-label-title">
              {t("settings.video.experimentalL4SRequest")}
              <span className="settings-inline-badge settings-inline-badge--beta">
                {t("app.labels.beta")}
              </span>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-enable-l4s"
              type="checkbox"
              checked={settings.enableL4S}
              onChange={(event) => handleChange("enableL4S", event.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">
          {t("settings.video.experimentalL4SRequestHint")}
        </span>
      </div>

      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label
            className="settings-label settings-label--wrap"
            htmlFor="settings-stream-auto-recovery-bitrate"
          >
            <span className="settings-label-title">
              {t("settings.video.autoRecoveryBitrate")}
              <span className="settings-inline-badge settings-inline-badge--beta">
                {t("app.labels.experimental")}
              </span>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-auto-recovery-bitrate"
              type="checkbox"
              checked={settings.autoRecoveryBitrate}
              onChange={(event) => handleChange("autoRecoveryBitrate", event.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">
          {t("settings.video.autoRecoveryBitrateHint")}
        </span>
      </div>

      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label className="settings-label settings-label--wrap" htmlFor="settings-stream-compositor-safe-mode">
            <span className="settings-label-title">
              {t("settings.video.compositorSafeMode")}
              <span className="settings-inline-badge settings-inline-badge--beta">{t("app.labels.experimental")}</span>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-compositor-safe-mode"
              type="checkbox"
              checked={settings.compositorSafeMode}
              onChange={(event) => handleChange("compositorSafeMode", event.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">{t("settings.video.compositorSafeModeHint")}</span>
      </div>

      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label className="settings-label settings-label--wrap" htmlFor="settings-stream-smooth-playback-buffer">
            <span className="settings-label-title">
              {t("settings.video.smoothPlaybackBuffer")}
              <span className="settings-inline-badge settings-inline-badge--beta">{t("app.labels.experimental")}</span>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-smooth-playback-buffer"
              type="checkbox"
              checked={settings.smoothPlaybackBuffer}
              onChange={(event) => handleChange("smoothPlaybackBuffer", event.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">{t("settings.video.smoothPlaybackBufferHint")}</span>
      </div>

      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label
            className="settings-label settings-label--wrap"
            htmlFor="settings-stream-identify-steam-deck"
          >
            <span className="settings-label-title">
              {t("settings.video.identifyAsSteamDeck")}
              <span className="settings-inline-badge settings-inline-badge--beta">
                {t("app.labels.experimental")}
              </span>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-identify-steam-deck"
              type="checkbox"
              checked={settings.identifyAsSteamDeck}
              onChange={(event) => {
                handleChange("identifyAsSteamDeck", event.target.checked);
              }}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">
          {t("settings.video.identifyAsSteamDeckHint")}
        </span>
      </div>

      <div className="settings-row settings-row--toggle">
        <div className="settings-row-top settings-row-top--compact">
          <label
            className="settings-label settings-label--wrap"
            htmlFor="settings-stream-identify-console"
          >
            <span className="settings-label-title">
              {t("settings.video.identifyAsConsole")}
            </span>
          </label>
          <label className="settings-toggle">
            <input
              id="settings-stream-identify-console"
              type="checkbox"
              checked={settings.launchInConsoleMode}
              onChange={(event) => {
                handleChange("launchInConsoleMode", event.target.checked);
              }}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
        <span className="settings-subtle-hint">
          {t("settings.video.identifyAsConsoleHint")}
        </span>
      </div>

    </>
  );
}
