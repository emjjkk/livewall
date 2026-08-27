import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "../types/settings";

export function useSettings() {
	const [settings, setSettings] = useState<AppSettings | null>(null);

	useEffect(() => {
		// Fetch initial settings from disk
		invoke<AppSettings>("get_settings").then(setSettings).catch(console.error);

		// Keep state in sync between main window & settings window
		const unlisten = listen<AppSettings>("settings-changed", (event) => {
			setSettings(event.payload);
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	const updateSettings = useCallback(async (newSettings: AppSettings) => {
		setSettings(newSettings);
		await invoke("update_settings", { newSettings });
	}, []);

	return {
		settings,
		setSettings,
		updateSettings,
	};
}
