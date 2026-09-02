import {
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
    AppSettings,
    ForwardingScope,
    WallpaperOverlay,
} from "../types/settings";

interface SettingsWindowProps {
    settings: AppSettings;
    onUpdate: (cfg: AppSettings) => void;
}

type Tab = "wallpaper" | "widgets";

const inputClass =
    "w-full border border-neutral-200 bg-white px-2 py-1.5 text-[11px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-600";

const primaryButtonClass =
    "shrink-0 border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-neutral-700 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300";

const subtleButtonClass =
    "border border-transparent px-2 py-1.5 text-[11px] text-neutral-500 transition-colors hover:border-neutral-200 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-500 dark:hover:border-neutral-800 dark:hover:bg-neutral-950 dark:hover:text-neutral-100";

export function SettingsWindow({
    settings,
    onUpdate,
}: SettingsWindowProps) {
    const [tab, setTab] = useState<Tab>("wallpaper");
    const [urlInput, setUrlInput] = useState("");
    const [overlayUrlInput, setOverlayUrlInput] = useState("");
    const [isSavingFile, setIsSavingFile] = useState(false);
    const [expandedOverlays, setExpandedOverlays] = useState<
        Record<string, boolean>
    >({});

    const toggleSetting = (
        key:
            | "autostart"
            | "pause_on_battery"
            | "pause_on_unfocus"
            | "is_muted",
    ) => {
        onUpdate({
            ...settings,
            [key]: !settings[key],
        });
    };

    const updateVolume = (volume: number) => {
        onUpdate({
            ...settings,
            volume,
        });
    };

    /*
     * IMPORTANT:
     *
     * Do not use <input type="file"> + file.arrayBuffer() here.
     *
     * That forces the entire video through the WebView/JS process.
     * Instead, use Tauri's native file picker and pass only the
     * filesystem path to Rust.
     */
    const handleFileUpload = async () => {
        if (isSavingFile) {
            return;
        }

        try {
            const selected = await open({
                multiple: false,
                directory: false,
                title: "Choose wallpaper",
                filters: [
                    {
                        name: "Images",
                        extensions: [
                            "jpg",
                            "jpeg",
                            "png",
                            "gif",
                            "webp",
                            "bmp",
                            "svg",
                        ],
                    },
                    {
                        name: "Videos",
                        extensions: [
                            "mp4",
                            "webm",
                            "ogg",
                            "mov",
                            "m4v",
                            "avi",
                            "mkv",
                        ],
                    },
                ],
            });

            if (!selected || Array.isArray(selected)) {
                return;
            }

            const filePath = selected;
            setIsSavingFile(true);

            /*
             * Only the path crosses IPC.
             *
             * Rust performs the actual file copy directly from disk.
             */
            const savedPath = await invoke<string>("save_wallpaper_file", {
                sourcePath: filePath,
            });

            const extension =
                filePath
                    .split(/[\\/]/)
                    .pop()
                    ?.split(".")
                    .pop()
                    ?.toLowerCase() ?? "";

            const videoExtensions = new Set([
                "mp4",
                "webm",
                "ogg",
                "mov",
                "m4v",
                "avi",
                "mkv",
            ]);

            const isVideo = videoExtensions.has(extension);

            onUpdate({
                ...settings,
                wallpaper_type: isVideo ? "video" : "image",
                wallpaper_src: convertFileSrc(savedPath),
            });
        } catch (err) {
            console.error("Failed to save wallpaper file:", err);
        } finally {
            setIsSavingFile(false);
        }
    };

    const handleUrlApply = () => {
        let url = urlInput.trim();

        if (!url) {
            return;
        }

        if (!/^https?:\/\//i.test(url)) {
            url = `https://${url}`;
        }

        const isDirectVideo =
            /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(url);

        const isDirectImage =
            /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?.*)?$/i.test(url);

        let wallpaper_type: AppSettings["wallpaper_type"] = "webpage";

        if (isDirectVideo) {
            wallpaper_type = "video";
        } else if (isDirectImage) {
            wallpaper_type = "image";
        }

        onUpdate({
            ...settings,
            wallpaper_type,
            wallpaper_src: url,
        });

        setUrlInput("");
    };

    const handleAddOverlay = () => {
        const url = overlayUrlInput.trim();

        if (!url) {
            return;
        }

        const overlay: WallpaperOverlay = {
            id: crypto.randomUUID(),
            url,
            x: 0,
            y: 0,
            width: 400,
            height: 200,
            forwarding_enabled: false,
            forwarding_url: "",
            forwarding_scopes: [],
        };

        onUpdate({
            ...settings,
            overlays: [...settings.overlays, overlay],
        });

        setOverlayUrlInput("");

        setExpandedOverlays((current) => ({
            ...current,
            [overlay.id]: true,
        }));
    };

    const updateOverlay = (
        id: string,
        changes: Partial<WallpaperOverlay>,
    ) => {
        onUpdate({
            ...settings,
            overlays: settings.overlays.map((overlay) =>
                overlay.id === id
                    ? { ...overlay, ...changes }
                    : overlay,
            ),
        });
    };

    const removeOverlay = (id: string) => {
        onUpdate({
            ...settings,
            overlays: settings.overlays.filter(
                (overlay) => overlay.id !== id,
            ),
        });

        setExpandedOverlays((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    };

    /*
     * X/Y are anchor percentages:
     *
     * X:
     *   0   = widget center anchored to left
     *   50  = widget center anchored to center
     *   100 = widget center anchored to right
     *
     * Y:
     *   0   = widget center anchored to top
     *   50  = widget center anchored to center
     *   100 = widget center anchored to bottom
     *
     * The wallpaper renderer should therefore position the widget
     * using these values as the CENTER anchor, e.g.
     *
     * left: `${x}%`
     * top: `${y}%`
     * transform: translate(-50%, -50%)
     */
    const setOverlayPosition = (
        overlay: WallpaperOverlay,
        horizontal?: "left" | "center" | "right",
        vertical?: "top" | "center" | "bottom",
    ) => {
        const changes: Partial<WallpaperOverlay> = {};

        if (horizontal) {
            changes.x =
                horizontal === "left"
                    ? 0
                    : horizontal === "center"
                        ? 50
                        : 100;
        }

        if (vertical) {
            changes.y =
                vertical === "top"
                    ? 0
                    : vertical === "center"
                        ? 50
                        : 100;
        }

        updateOverlay(overlay.id, changes);
    };

    const toggleForwardingScope = (
        overlay: WallpaperOverlay,
        scope: ForwardingScope,
    ) => {
        const has = overlay.forwarding_scopes.includes(scope);

        updateOverlay(overlay.id, {
            forwarding_scopes: has
                ? overlay.forwarding_scopes.filter((s) => s !== scope)
                : [...overlay.forwarding_scopes, scope],
        });
    };

    return (
        <div className="flex h-screen w-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
            <header className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
                <nav className="flex">
                    <TabButton
                        active={tab === "wallpaper"}
                        onClick={() => setTab("wallpaper")}
                    >
                        Wallpaper
                    </TabButton>

                    <TabButton
                        active={tab === "widgets"}
                        onClick={() => setTab("widgets")}
                    >
                        Widgets

                        {settings.overlays.length > 0 && (
                            <span className="ml-1.5 font-mono text-[9px] text-neutral-400">
                                {settings.overlays.length}
                            </span>
                        )}
                    </TabButton>
                </nav>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-xl px-4 py-3">
                    {tab === "wallpaper" ? (
                        <WallpaperTab
                            settings={settings}
                            urlInput={urlInput}
                            setUrlInput={setUrlInput}
                            isSavingFile={isSavingFile}
                            handleFileUpload={handleFileUpload}
                            handleUrlApply={handleUrlApply}
                            toggleSetting={toggleSetting}
                            updateVolume={updateVolume}
                        />
                    ) : (
                        <WidgetsTab
                            settings={settings}
                            overlayUrlInput={overlayUrlInput}
                            setOverlayUrlInput={setOverlayUrlInput}
                            expandedOverlays={expandedOverlays}
                            setExpandedOverlays={setExpandedOverlays}
                            handleAddOverlay={handleAddOverlay}
                            updateOverlay={updateOverlay}
                            removeOverlay={removeOverlay}
                            setOverlayPosition={setOverlayPosition}
                            toggleForwardingScope={toggleForwardingScope}
                        />
                    )}
                </div>
            </main>

            <footer className="shrink-0 items-center justify-between border-t border-neutral-200 px-4 py-4 text-[9px] text-neutral-400 dark:border-neutral-800">
                <p className="mb-2 text-[10px] text-white">
                    Any URL can be used as a wallpaper or widget source.
                    There's a helpful list of URLs you can use for
                    wallpapers and widgets in the README.md of Livewall's
                    repository on Github, to which you can also contribute
                    your own~
                </p>

                <p className="text-[10px]">
                    Built with Rust and Typescript by @emjjkk
                </p>
            </footer>
        </div>
    );
}

function WallpaperTab({
    settings,
    urlInput,
    setUrlInput,
    isSavingFile,
    handleFileUpload,
    handleUrlApply,
    toggleSetting,
    updateVolume,
}: {
    settings: AppSettings;
    urlInput: string;
    setUrlInput: (value: string) => void;
    isSavingFile: boolean;
    handleFileUpload: () => void;
    handleUrlApply: () => void;
    toggleSetting: (
        key:
            | "autostart"
            | "pause_on_battery"
            | "pause_on_unfocus"
            | "is_muted",
    ) => void;
    updateVolume: (volume: number) => void;
}) {
    return (
        <div>
            <div className="flex gap-1.5">
                <input
                    type="url"
                    placeholder="Wallpaper URL"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleUrlApply();
                        }
                    }}
                    className={inputClass}
                />

                <button
                    type="button"
                    onClick={handleUrlApply}
                    className={primaryButtonClass}
                >
                    Apply
                </button>
            </div>

            <button
                type="button"
                onClick={handleFileUpload}
                disabled={isSavingFile}
                className="mt-1.5 flex w-full cursor-pointer items-center justify-between border border-dashed border-neutral-200 px-2.5 py-2 text-left disabled:cursor-wait disabled:opacity-60 dark:border-neutral-800"
            >
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {isSavingFile
                        ? "Copying wallpaper..."
                        : "Local image or video"}
                </span>

                <span className="font-mono text-[9px] uppercase tracking-wide text-neutral-400">
                    {isSavingFile ? "Please wait" : "Browse"}
                </span>
            </button>

            <div className="mt-4 border-y border-neutral-200 dark:border-neutral-800">
                <SettingRow
                    label="Volume"
                    value={
                        settings.is_muted
                            ? "Muted"
                            : `${Math.round(settings.volume * 100)}%`
                    }
                >
                    <button
                        type="button"
                        onClick={() => toggleSetting("is_muted")}
                        className={subtleButtonClass}
                    >
                        {settings.is_muted ? "Unmute" : "Mute"}
                    </button>
                </SettingRow>

                <div className="border-b border-neutral-200 pb-2.5 dark:border-neutral-800">
                    <VolumeControl
                        settings={settings}
                        onChange={updateVolume}
                    />
                </div>

                <ToggleRow
                    label="Run on startup"
                    checked={settings.autostart}
                    onChange={() => toggleSetting("autostart")}
                />

                <ToggleRow
                    label="Pause when on battery power"
                    checked={settings.pause_on_battery}
                    onChange={() =>
                        toggleSetting("pause_on_battery")
                    }
                />

                <ToggleRow
                    label="Pause when unfocused"
                    checked={settings.pause_on_unfocus}
                    onChange={() =>
                        toggleSetting("pause_on_unfocus")
                    }
                />
            </div>

            <div className="mt-3 truncate font-mono text-[9px] text-neutral-400">
                Current wallpaper source:
                <br />
                {settings.wallpaper_src}
            </div>
        </div>
    );
}

function VolumeControl({
    settings,
    onChange,
}: {
    settings: AppSettings;
    onChange: (value: number) => void;
}) {
    const [value, setValue] = useState(settings.volume);

    useEffect(() => {
        setValue(settings.volume);
    }, [settings.volume]);

    const handleChange = (next: number) => {
        setValue(next);
        onChange(next);
    };

    return (
        <div className="flex items-center gap-3">
            <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={settings.is_muted ? 0 : value}
                disabled={settings.is_muted}
                onChange={(e) =>
                    handleChange(parseFloat(e.target.value))
                }
                className="h-1 w-full cursor-pointer appearance-none rounded-none bg-neutral-200 accent-neutral-900 disabled:cursor-default disabled:opacity-30 dark:bg-neutral-800 dark:accent-white"
            />

            <span className="w-8 shrink-0 text-right font-mono text-[9px] text-neutral-400">
                {settings.is_muted
                    ? "0%"
                    : `${Math.round(value * 100)}%`}
            </span>
        </div>
    );
}

function WidgetsTab({
    settings,
    overlayUrlInput,
    setOverlayUrlInput,
    expandedOverlays,
    setExpandedOverlays,
    handleAddOverlay,
    updateOverlay,
    removeOverlay,
    setOverlayPosition,
    toggleForwardingScope,
}: {
    settings: AppSettings;
    overlayUrlInput: string;
    setOverlayUrlInput: (value: string) => void;
    expandedOverlays: Record<string, boolean>;
    setExpandedOverlays: React.Dispatch<
        React.SetStateAction<Record<string, boolean>>
    >;
    handleAddOverlay: () => void;
    updateOverlay: (
        id: string,
        changes: Partial<WallpaperOverlay>,
    ) => void;
    removeOverlay: (id: string) => void;
    setOverlayPosition: (
        overlay: WallpaperOverlay,
        horizontal?: "left" | "center" | "right",
        vertical?: "top" | "center" | "bottom",
    ) => void;
    toggleForwardingScope: (
        overlay: WallpaperOverlay,
        scope: ForwardingScope,
    ) => void;
}) {
    return (
        <div>
            <div className="flex gap-1.5">
                <input
                    type="url"
                    placeholder="Widget URL"
                    value={overlayUrlInput}
                    onChange={(e) => setOverlayUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleAddOverlay();
                        }
                    }}
                    className={inputClass}
                />

                <button
                    type="button"
                    onClick={handleAddOverlay}
                    className={primaryButtonClass}
                >
                    Add
                </button>
            </div>

            <div className="mt-3 divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {settings.overlays.length === 0 ? (
                    <div className="py-8 text-center font-mono text-[10px] text-neutral-400">
                        No widgets
                    </div>
                ) : (
                    settings.overlays.map((overlay) => {
                        const expanded =
                            expandedOverlays[overlay.id] ?? false;

                        return (
                            <div key={overlay.id} className="py-2.5">
                                <div className="flex items-center justify-between gap-3">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setExpandedOverlays(
                                                (current) => ({
                                                    ...current,
                                                    [overlay.id]:
                                                        !expanded,
                                                }),
                                            )
                                        }
                                        className="min-w-0 flex-1 truncate text-left font-mono text-[10px] font-bold text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                                    >
                                        {getHostname(overlay.url)}
                                        {overlay.forwarding_enabled && (
                                            <span className="ml-1.5 text-neutral-400">
                                                · forwarding
                                            </span>
                                        )}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() =>
                                            removeOverlay(overlay.id)
                                        }
                                        className={subtleButtonClass}
                                    >
                                        Remove
                                    </button>
                                </div>

                                {expanded && (
                                    <div className="mt-3 space-y-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableNumber
                                                label="X"
                                                value={overlay.x}
                                                min={0}
                                                max={100}
                                                step={1}
                                                suffix="%"
                                                onChange={(value) =>
                                                    updateOverlay(
                                                        overlay.id,
                                                        { x: value },
                                                    )
                                                }
                                            />

                                            <ScrubbableNumber
                                                label="Y"
                                                value={overlay.y}
                                                min={0}
                                                max={100}
                                                step={1}
                                                suffix="%"
                                                onChange={(value) =>
                                                    updateOverlay(
                                                        overlay.id,
                                                        { y: value },
                                                    )
                                                }
                                            />

                                            <ScrubbableNumber
                                                label="W"
                                                value={overlay.width}
                                                min={1}
                                                max={4320}
                                                step={1}
                                                suffix="px"
                                                onChange={(value) =>
                                                    updateOverlay(
                                                        overlay.id,
                                                        { width: value },
                                                    )
                                                }
                                            />

                                            <ScrubbableNumber
                                                label="H"
                                                value={overlay.height}
                                                min={1}
                                                max={4320}
                                                step={1}
                                                suffix="px"
                                                onChange={(value) =>
                                                    updateOverlay(
                                                        overlay.id,
                                                        { height: value },
                                                    )
                                                }
                                            />
                                        </div>

                                        <div className="space-y-1.5">
                                            <AlignmentRow
                                                label="X"
                                                value={overlay.x}
                                                buttons={[
                                                    {
                                                        label: "Left",
                                                        active:
                                                            overlay.x ===
                                                            0,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                "left",
                                                            ),
                                                    },
                                                    {
                                                        label: "Center",
                                                        active:
                                                            overlay.x ===
                                                            50,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                "center",
                                                            ),
                                                    },
                                                    {
                                                        label: "Right",
                                                        active:
                                                            overlay.x ===
                                                            100,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                "right",
                                                            ),
                                                    },
                                                ]}
                                            />

                                            <AlignmentRow
                                                label="Y"
                                                value={overlay.y}
                                                buttons={[
                                                    {
                                                        label: "Top",
                                                        active:
                                                            overlay.y ===
                                                            0,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                undefined,
                                                                "top",
                                                            ),
                                                    },
                                                    {
                                                        label: "Center",
                                                        active:
                                                            overlay.y ===
                                                            50,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                undefined,
                                                                "center",
                                                            ),
                                                    },
                                                    {
                                                        label: "Bottom",
                                                        active:
                                                            overlay.y ===
                                                            100,
                                                        onClick: () =>
                                                            setOverlayPosition(
                                                                overlay,
                                                                undefined,
                                                                "bottom",
                                                            ),
                                                    },
                                                ]}
                                            />
                                        </div>

                                        <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                                            <ToggleRow
                                                label="Forward data to a URL"
                                                description="POST this widget's requested data as JSON every ~5s"
                                                checked={
                                                    overlay.forwarding_enabled
                                                }
                                                onChange={() =>
                                                    updateOverlay(
                                                        overlay.id,
                                                        {
                                                            forwarding_enabled:
                                                                !overlay.forwarding_enabled,
                                                        },
                                                    )
                                                }
                                            />

                                            {overlay.forwarding_enabled && (
                                                <div className="space-y-2">
                                                    <input
                                                        type="url"
                                                        placeholder="https://your-endpoint.example/data"
                                                        value={
                                                            overlay.forwarding_url
                                                        }
                                                        onChange={(e) =>
                                                            updateOverlay(
                                                                overlay.id,
                                                                {
                                                                    forwarding_url:
                                                                        e
                                                                            .target
                                                                            .value,
                                                                },
                                                            )
                                                        }
                                                        className={
                                                            inputClass
                                                        }
                                                    />

                                                    <ToggleRow
                                                        label="Hardware"
                                                        description="CPU usage, RAM usage, approximate GPU usage"
                                                        checked={overlay.forwarding_scopes.includes(
                                                            "hardware",
                                                        )}
                                                        onChange={() =>
                                                            toggleForwardingScope(
                                                                overlay,
                                                                "hardware",
                                                            )
                                                        }
                                                    />

                                                    <ToggleRow
                                                        label="Media"
                                                        description="Currently playing track/artist and playback state"
                                                        checked={overlay.forwarding_scopes.includes("media")}
                                                        onChange={() => toggleForwardingScope(overlay, "media")}
                                                    />

                                                    <ToggleRow
                                                        label="Windows"
                                                        description="Titles of all currently open windows"
                                                        checked={overlay.forwarding_scopes.includes(
                                                            "windows",
                                                        )}
                                                        onChange={() =>
                                                            toggleForwardingScope(
                                                                overlay,
                                                                "windows",
                                                            )
                                                        }
                                                    />

                                                    <p className="text-[9px] text-neutral-400">
                                                        Data is sent as-is
                                                        to the URL above —
                                                        only use endpoints
                                                        you trust, since
                                                        window titles can
                                                        contain sensitive
                                                        information.
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

function AlignmentRow({
    label,
    value,
    buttons,
}: {
    label: string;
    value: number;
    buttons: {
        label: string;
        active: boolean;
        onClick: () => void;
    }[];
}) {
    return (
        <div className="flex items-center gap-2">
            <div className="flex w-7 shrink-0 items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-wide text-neutral-400">
                    {label}
                </span>

                <span className="font-mono text-[8px] text-neutral-400">
                    {formatNumber(value)}%
                </span>
            </div>

            <div className="grid min-w-0 flex-1 grid-cols-3 border border-neutral-200 dark:border-neutral-800">
                {buttons.map((button) => (
                    <AlignmentButton
                        key={button.label}
                        active={button.active}
                        onClick={button.onClick}
                    >
                        {button.label}
                    </AlignmentButton>
                ))}
            </div>
        </div>
    );
}

function ScrubbableNumber({
    label,
    value,
    min,
    max,
    step,
    suffix,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix: string;
    onChange: (value: number) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(String(value));

    const startX = useRef(0);
    const startValue = useRef(value);
    const dragging = useRef(false);

    useEffect(() => {
        if (!editing && !dragging.current) {
            setDraft(formatNumber(value));
        }
    }, [value, editing]);

    const commit = () => {
        const parsed = Number(draft);

        if (Number.isFinite(parsed)) {
            const next = clampNumber(parsed, min, max);
            const rounded = roundToStep(next, step);

            onChange(rounded);
            setDraft(formatNumber(rounded));
        } else {
            setDraft(formatNumber(value));
        }

        setEditing(false);
    };

    const handlePointerDown = (
        e: ReactPointerEvent<HTMLButtonElement>,
    ) => {
        if (e.button !== 0) {
            return;
        }

        dragging.current = false;
        startX.current = e.clientX;
        startValue.current = value;

        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (
        e: ReactPointerEvent<HTMLButtonElement>,
    ) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
            return;
        }

        const delta = e.clientX - startX.current;

        if (Math.abs(delta) > 2) {
            dragging.current = true;
        }

        if (!dragging.current) {
            return;
        }

        const pixelsPerStep = step < 1 ? 4 : 2;
        const steps = Math.round(delta / pixelsPerStep);

        const next = clampNumber(
            startValue.current + steps * step,
            min,
            max,
        );

        onChange(roundToStep(next, step));
    };

    const handlePointerUp = (
        e: ReactPointerEvent<HTMLButtonElement>,
    ) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }

        if (!dragging.current) {
            setEditing(true);
            setDraft(formatNumber(value));
        }

        dragging.current = false;
    };

    if (editing) {
        return (
            <div className="flex items-center gap-2">
                <span className="w-4 font-mono text-[9px] text-neutral-400">
                    {label}
                </span>

                <input
                    autoFocus
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            commit();
                        }

                        if (e.key === "Escape") {
                            setEditing(false);
                            setDraft(formatNumber(value));
                        }
                    }}
                    className={`${inputClass} py-1`}
                />

                <span className="w-5 text-right font-mono text-[9px] text-neutral-400">
                    {suffix}
                </span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <span className="w-4 font-mono text-[9px] text-neutral-400">
                {label}
            </span>

            <button
                type="button"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="flex min-w-0 flex-1 cursor-ew-resize select-none items-center justify-between border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-left font-mono text-[10px] text-neutral-700 hover:border-neutral-300 hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-700 dark:hover:bg-neutral-800"
                title="Drag to adjust. Click to type."
            >
                <span>{formatNumber(value)}</span>

                <span className="ml-2 text-[8px] text-neutral-400">
                    {suffix}
                </span>
            </button>
        </div>
    );
}

function AlignmentButton({
    children,
    active,
    onClick,
}: {
    children: React.ReactNode;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`border-r border-neutral-200 px-2 py-1.5 text-[9px] transition-colors last:border-r-0 dark:border-neutral-800 ${active
                    ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-white"
                    : "bg-white text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 dark:bg-neutral-950 dark:text-neutral-500 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
                }`}
        >
            {children}
        </button>
    );
}

function SettingRow({
    label,
    value,
    children,
}: {
    label: string;
    value?: string;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex min-h-10 items-center justify-between gap-3">
            <span className="text-[11px] text-neutral-700 dark:text-neutral-300">
                {label}
            </span>

            <div className="flex items-center gap-2">
                {value && (
                    <span className="font-mono text-[9px] text-neutral-400">
                        {value}
                    </span>
                )}

                {children}
            </div>
        </div>
    );
}

function ToggleRow({
    label,
    description,
    checked,
    onChange,
}: {
    label: string;
    description?: string;
    checked: boolean;
    onChange: () => void;
}) {
    return (
        <div className="flex min-h-10 items-center justify-between gap-3">
            <div className="pr-3">
                <p className="text-[11px] text-neutral-700 dark:text-neutral-300">
                    {label}
                </p>

                {description && (
                    <p className="mt-0.5 text-[9px] text-neutral-400">
                        {description}
                    </p>
                )}
            </div>

            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={onChange}
                className={`relative h-3.5 w-6 shrink-0 border transition-colors ${checked
                        ? "border-neutral-900 bg-neutral-900 dark:border-neutral-100 dark:bg-neutral-100"
                        : "border-neutral-300 bg-transparent dark:border-neutral-700"
                    }`}
            >
                <span
                    className={`absolute top-0.5 h-2 w-2 transition-transform ${checked
                            ? "translate-x-3 bg-white dark:bg-neutral-950"
                            : "translate-x-0.5 bg-neutral-400"
                        }`}
                />
            </button>
        </div>
    );
}

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`relative px-2.5 py-2 text-[11px] transition-colors ${active
                    ? "text-neutral-900 dark:text-white"
                    : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                }`}
        >
            {children}

            {active && (
                <span className="absolute inset-x-2 bottom-0 h-px bg-neutral-900 dark:bg-neutral-100" />
            )}
        </button>
    );
}

function getHostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function clampNumber(
    value: number,
    min: number,
    max: number,
): number {
    if (!Number.isFinite(value)) {
        return min;
    }

    return Math.min(Math.max(value, min), max);
}

function roundToStep(value: number, step: number): number {
    const decimals =
        step < 1
            ? (String(step).split(".")[1]?.length ?? 1)
            : 0;

    const multiplier = 10 ** decimals;

    return Math.round(value * multiplier) / multiplier;
}

function formatNumber(value: number): string {
    return Number.isInteger(value)
        ? String(value)
        : value.toFixed(1);
}