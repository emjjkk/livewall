import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
	attach,
	capabilities,
	onOcclusionChanged,
	onReattached,
	startOcclusionMonitor,
	stopOcclusionMonitor,
} from "tauri-plugin-wallpaper";

import type { AppSettings } from "../types/settings";

interface WallpaperWindowProps {
	settings: AppSettings;
}

function getWidgetUrl(overlay: {
    url: string;
    id: string;
}) {
    try {
        const url = new URL(overlay.url);
        url.searchParams.set("widget_id", overlay.id);
        return url.toString();
    } catch {
        return overlay.url;
    }
}

export function WallpaperWindow({
	settings,
}: WallpaperWindowProps) {
	const [isPaused, setIsPaused] = useState(false);
	const [isOccluded, setIsOccluded] = useState(false);

	const videoRef = useRef<HTMLVideoElement>(null);
	const iframeRefs = useRef<
		Record<string, HTMLIFrameElement | null>
	>({});

	/*
	 * Attach the window to the desktop wallpaper layer and enable
	 * native mouse/keyboard forwarding.
	 *
	 * This is what makes widgets genuinely interactive.
	 */
	useEffect(() => {
		let cancelled = false;
		let unlistenReattached: (() => void) | undefined;
		let unlistenOcclusion: (() => void) | undefined;

		const initializeWallpaper = async () => {
			try {
				const caps = await capabilities();

				if (!caps.attach) {
					console.warn(
						"Wallpaper attachment is not supported on this platform.",
					);
					return;
				}

				/*
				 * Attach with native Windows input forwarding.
				 *
				 * On Windows:
				 * - mouse events are forwarded to WebView2
				 * - keyboard input works when the desktop is active
				 * - input is not forwarded while another application
				 *   is being used
				 */
				await attach({
					windowLabel: "main",
					forwardMouseInput:
						caps.inputForwarding,
					forwardKeyboardInput:
						caps.inputForwarding,
				});

				if (cancelled) {
					return;
				}

				/*
				 * Explorer can recreate the WorkerW wallpaper layer.
				 * The plugin automatically reattaches the window.
				 */
				unlistenReattached =
					await onReattached(
						({ windowLabel }) => {
							if (windowLabel !== "main") {
								return;
							}

							/*
							 * Give media a nudge after the desktop
							 * layer has been recreated.
							 */
							const video =
								videoRef.current;

							if (
								video &&
								!video.paused &&
								video.readyState >= 2
							) {
								video.play().catch(() => { });
							}
						},
					);

				/*
				 * Occlusion monitoring allows Livewall to stop
				 * rendering while a fullscreen application is
				 * covering the wallpaper.
				 */
				if (caps.occlusion) {
					await startOcclusionMonitor();

					if (cancelled) {
						return;
					}

					unlistenOcclusion =
						await onOcclusionChanged(
							({ windowLabel, occluded }) => {
								if (
									windowLabel &&
									windowLabel !== "main"
								) {
									return;
								}

								setIsOccluded(occluded);
							},
						);
				}
			} catch (error) {
				console.error(
					"Failed to initialize Livewall wallpaper:",
					error,
				);
			}
		};

		void initializeWallpaper();

		return () => {
			cancelled = true;

			unlistenReattached?.();
			unlistenOcclusion?.();

			void stopOcclusionMonitor().catch(() => { });
		};
	}, []);

	/*
	 * Determine whether the wallpaper should be paused because
	 * of user settings.
	 *
	 * We deliberately do NOT use document.hasFocus().
	 *
	 * The wallpaper plugin can temporarily give the wallpaper
	 * window real focus in order to make keyboard forwarding work.
	 * Checking the native Windows foreground window avoids the
	 * old false-positive pause behaviour.
	 */
	useEffect(() => {
		let cancelled = false;
		let interval:
			| ReturnType<typeof setInterval>
			| undefined;

		const evaluatePauseConditions =
			async () => {
				let pause = false;

				/*
				 * Fullscreen/occluded content is always paused.
				 *
				 * There is no visual benefit to rendering an
				 * invisible wallpaper and this is the main CPU/GPU
				 * optimization provided by the plugin.
				 */
				if (isOccluded) {
					pause = true;
				}

				/*
				 * Battery setting.
				 */
				if (
					settings.pause_on_battery &&
					!pause
				) {
					try {
						const onBattery =
							await invoke<boolean>(
								"check_is_on_battery",
							);

						if (onBattery) {
							pause = true;
						}
					} catch {
						/*
						 * Browser battery API fallback.
						 */
						if (
							"getBattery" in
							navigator
						) {
							try {
								const battery =
									await (
										navigator as Navigator & {
											getBattery?: () => Promise<{
												charging: boolean;
											}>;
										}
									).getBattery?.();

								if (
									battery &&
									!battery.charging
								) {
									pause = true;
								}
							} catch {
								// Ignore battery API failures.
							}
						}
					}
				}

				/*
				 * Desktop focus setting.
				 *
				 * Native Windows foreground state is used rather
				 * than document.hasFocus().
				 */
				if (
					settings.pause_on_unfocus &&
					!pause
				) {
					try {
						const desktopFocused =
							await invoke<boolean>(
								"is_desktop_focused",
							);

						if (!desktopFocused) {
							pause = true;
						}
					} catch {
						/*
						 * Do not accidentally pause the wallpaper
						 * if the native check itself fails.
						 */
					}
				}

				if (!cancelled) {
					setIsPaused(pause);
				}
			};

		void evaluatePauseConditions();

		interval = setInterval(
			() => {
				void evaluatePauseConditions();
			},
			1000,
		);

		return () => {
			cancelled = true;

			if (interval) {
				clearInterval(interval);
			}
		};
	}, [
		isOccluded,
		settings.pause_on_battery,
		settings.pause_on_unfocus,
	]);

	/*
	 * Video playback and audio.
	 */
	useEffect(() => {
		const video = videoRef.current;

		if (!video) {
			return;
		}

		video.volume = settings.is_muted
			? 0
			: Math.min(
				1,
				Math.max(0, settings.volume),
			);

		if (isPaused) {
			video.pause();
		} else {
			video.play().catch(() => { });
		}
	}, [
		isPaused,
		settings.volume,
		settings.is_muted,
		settings.wallpaper_src,
	]);

	/*
	 * Video playback watchdog.
	 *
	 * Keep this lightweight. The old watchdog attempted recovery
	 * every 8 seconds regardless of whether the browser actually
	 * needed it.
	 */
	useEffect(() => {
		const video = videoRef.current;

		if (
			!video ||
			settings.wallpaper_type !== "video"
		) {
			return;
		}

		const resumeIfNeeded = () => {
			if (
				!isPaused &&
				!isOccluded &&
				video.paused &&
				video.readyState >= 2
			) {
				video.play().catch(() => { });
			}
		};

		video.addEventListener(
			"stalled",
			resumeIfNeeded,
		);

		video.addEventListener(
			"suspend",
			resumeIfNeeded,
		);

		const watchdog = setInterval(
			resumeIfNeeded,
			15000,
		);

		return () => {
			video.removeEventListener(
				"stalled",
				resumeIfNeeded,
			);

			video.removeEventListener(
				"suspend",
				resumeIfNeeded,
			);

			clearInterval(watchdog);
		};
	}, [
		isPaused,
		isOccluded,
		settings.wallpaper_type,
	]);

	/*
	 * Keep webpage wallpaper audio synchronized.
	 */
	useEffect(() => {
		const iframe =
			iframeRefs.current["__wallpaper__"];

		if (!iframe?.contentWindow) {
			return;
		}

		iframe.contentWindow.postMessage(
			{
				type: "SET_AUDIO",
				volume: settings.is_muted
					? 0
					: settings.volume,
				isPaused,
			},
			"*",
		);
	}, [
		settings.volume,
		settings.is_muted,
		isPaused,
		settings.wallpaper_src,
	]);

	/*
	 * Notify widgets when the wallpaper enters/leaves its
	 * paused state.
	 */
	useEffect(() => {
		for (const overlay of settings.overlays) {
			const iframe =
				iframeRefs.current[overlay.id];

			if (!iframe?.contentWindow) {
				continue;
			}

			iframe.contentWindow.postMessage(
				{
					type: "SET_PAUSED",
					isPaused,
				},
				"*",
			);
		}
	}, [settings.overlays, isPaused]);

	return (
		<main className="relative h-screen w-screen overflow-hidden bg-black select-none">
			{/*
			 * Main wallpaper.
			 *
			 * The main wallpaper remains non-interactive so that
			 * clicking empty desktop space does not accidentally
			 * interact with the wallpaper webpage itself.
			 */}
			{settings.wallpaper_type ===
				"webpage" ? (
				<iframe
					ref={(element) => {
						iframeRefs.current[
							"__wallpaper__"
						] = element;
					}}
					src={settings.wallpaper_src}
					title="Wallpaper Webpage"
					className={`pointer-events-none absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${isPaused
							? "opacity-30"
							: "opacity-100"
						}`}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
				/>
			) : settings.wallpaper_type ===
				"video" ? (
				<video
					ref={videoRef}
					src={settings.wallpaper_src}
					autoPlay
					loop
					muted={settings.is_muted}
					playsInline
					className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isPaused
							? "opacity-30"
							: "opacity-100"
						}`}
				/>
			) : (
				<img
					src={settings.wallpaper_src}
					alt="Wallpaper"
					draggable={false}
					className="pointer-events-none absolute inset-0 h-full w-full object-cover"
				/>
			)}

			{/*
			 * Interactive URL widgets.
			 *
			 * These are intentionally pointer-events-auto.
			 *
			 * The wallpaper plugin forwards the desktop's mouse
			 * input into this window, and WebView2 then delivers
			 * normal DOM input to the iframe.
			 *
			 * This means:
			 *   - links can be clicked
			 *   - pages can scroll
			 *   - forms can receive input
			 *   - buttons work
			 *   - JavaScript interactions work
			 */}
			{settings.overlays.map(
				(overlay) => {
					const translateX =
						overlay.x === 0
							? "0%"
							: overlay.x === 100
								? "-100%"
								: "-50%";

					const translateY =
						overlay.y === 0
							? "0%"
							: overlay.y === 100
								? "-100%"
								: "-50%";

					return (
						<iframe
							key={overlay.id}
							ref={(element) => {
								iframeRefs.current[overlay.id] = element;
							}}
							src={getWidgetUrl(overlay)}
							title={`Livewall widget ${overlay.id}`}
							className="pointer-events-auto absolute border-0"
							style={{
								left: `${overlay.x}%`,
								top: `${overlay.y}%`,
								width: `${overlay.width}px`,
								height: `${overlay.height}px`,
								transform: `translate(${translateX}, ${translateY})`,
							}}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
						/>
					);
				},
			)}
		</main>
	);
}