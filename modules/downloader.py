import os
import json
import urllib.request
import urllib.error
import shutil
import sys
from datetime import datetime, timezone, timedelta
from tqdm import tqdm

# --- File Definitions ---

# Get the absolute path to the "data" directory
DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
TEMP_DOWNLOAD_DIR = os.path.join(DATA_DIR, ".download")

# --- Metadata Constants ---
CSV_META_FILE_NAME = "csv_meta.json"
CSV_META_FILE = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", CSV_META_FILE_NAME))

DEFAULT_CSV_METADATA = {
    "version": 1,
    "check_updates_on_startup": True,
    "hf_datasets": [
        {
            "hf_dataset_id": "newtextdoc1111/danbooru-tag-csv",
            "last_remote_check_timestamp": None,
            "csv_files": [
                {
                    "file_name": "danbooru_tags.csv",
                    "last_download": None,
                    "last_modified_on_hf": None,
                    "last_seen_modified_on_hf": None,
                },
                {
                    "file_name": "danbooru_tags_cooccurrence.csv",
                    "last_download": None,
                    "last_modified_on_hf": None,
                    "last_seen_modified_on_hf": None,
                },
            ],
        }
    ],
}

# --- HuggingFace Constants ---
HUGGINGFACE_URL = "https://huggingface.co"

# Minimum interval between automatic remote checks for CSV updates.
REMOTE_CHECK_COOLDOWN = timedelta(hours=24)


# --- Helper Functions ---
def get_file_path(file_name: str) -> str:
    """Returns the full local path for a given file_name."""
    return os.path.join(DATA_DIR, file_name)


def get_temp_download_path(file_name: str) -> str:
    """Returns the full temporary download path for a given file_name."""
    return os.path.join(TEMP_DOWNLOAD_DIR, file_name)


def check_file_valid(file_path):
    """Checks if a file is valid by verifying its existence and size."""
    return os.path.exists(file_path) and os.path.getsize(file_path) > 0


def parse_iso8601_utc(value):
    """
    Parses an ISO 8601 timestamp (including the 'Z' suffix used by the HuggingFace API)
    and returns it as a normalized UTC ISO 8601 string, or None if parsing fails.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


class Downloader:
    """
    Downloader class to manage downloading and checking of CSV files from HuggingFace.
    """

    def __init__(self):
        """Initializes the Downloader."""
        self.csv_meta_file_exists_at_start = False

        self._ensure_directories_exist()
        self.metadata = self._load_metadata()

    def get_default_csv_metadata(self):
        """Returns the default CSV metadata."""
        return json.loads(json.dumps(DEFAULT_CSV_METADATA))

    def _load_metadata(self) -> list:
        """Loads metadata from CSV_META_FILE. Returns default if not found or error."""
        default_metadata = self.get_default_csv_metadata()

        if not os.path.exists(CSV_META_FILE):
            print(f"[Magik Autocomplete] Metadata file not found: {CSV_META_FILE}. Using default metadata.")
            return default_metadata

        try:
            with open(CSV_META_FILE, "r", encoding="utf-8") as f:
                metadata = json.load(f)

                if not isinstance(metadata, dict) or metadata.get("version") != DEFAULT_CSV_METADATA["version"]:
                    print(
                        f"[Magik Autocomplete] Metadata version mismatch. Expected {DEFAULT_CSV_METADATA['version']}, "
                        f"found {metadata.get('version')}. Using default metadata."
                    )
                    return default_metadata
                else:
                    self.csv_meta_file_exists_at_start = True
                    return metadata

        except (IOError, json.JSONDecodeError) as e:
            print(f"[Magik Autocomplete] Error loading metadata from {CSV_META_FILE}: {e}. Using default metadata.")
            return default_metadata

    def _save_metadata(self):
        """Saves metadata to CSV_META_FILE."""
        try:
            os.makedirs(os.path.dirname(CSV_META_FILE), exist_ok=True)
            with open(CSV_META_FILE, "w", encoding="utf-8") as f:
                json.dump(self.metadata, f, indent=2)
        except IOError as e:
            print(f"[Magik Autocomplete] Error saving metadata to {CSV_META_FILE}: {e}")

    def _get_hf_dataset_file_last_modified_map(self, dataset_repo_id: str) -> dict:
        """
        Retrieves per-file lastModified timestamps for a HuggingFace dataset via the tree API
        (GET /api/datasets/{repo_id}/tree/main). Unlike the CDN-backed Last-Modified header on
        resolve URLs, these timestamps come from repo metadata and change when a file is updated.
        Returns a dict mapping file path -> normalized UTC ISO 8601 timestamp string.
        Returns an empty dict on any error.
        """
        url = f"{HUGGINGFACE_URL}/api/datasets/{dataset_repo_id}/tree/main"
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "ComfyUI-Autocomplete-Plus (Python urllib)",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                entries = json.loads(response.read().decode("utf-8"))

            timestamps = {}
            for entry in entries:
                if entry.get("type") != "file":
                    continue
                path = entry.get("path")
                normalized = parse_iso8601_utc(entry.get("lastModified"))
                if path and normalized:
                    timestamps[path] = normalized
            return timestamps
        except urllib.error.HTTPError as e:
            print(f"[Magik Autocomplete] HTTP error when listing files for dataset {dataset_repo_id}: {e.code} {e.reason}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"[Magik Autocomplete] Network or parse error when listing files for dataset {dataset_repo_id}: {e}")
        except Exception as e:
            print(f"[Magik Autocomplete] Unexpected error when listing files for dataset {dataset_repo_id}: {e}")
        return {}

    def _download_file_with_progress_sync(self, hf_dataset_id, file_name: str, metadata_entry: dict):
        """
        Downloads a file synchronously with progress display to a temporary location.
        """
        download_url = f"{HUGGINGFACE_URL}/datasets/{hf_dataset_id}/resolve/main/{file_name}"
        final_path = get_file_path(file_name)
        temp_path = get_temp_download_path(file_name)
        now_utc = datetime.now(timezone.utc).isoformat()

        print(f"[Magik Autocomplete] Attempting to download {file_name} from {download_url}")

        downloaded_size = 0
        total_size = 0

        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)

            req = urllib.request.Request(
                download_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 11.0; Win64)"},
            )

            with urllib.request.urlopen(req) as response:
                total_size_str = response.getheader("Content-Length")
                total_size = int(total_size_str) if total_size_str else None
                chunk_size = 8192

                with (
                    open(temp_path, "wb") as f_out,
                    tqdm(
                        total=total_size,
                        unit="B",
                        unit_scale=True,
                        unit_divisor=1024,
                        desc=f"[Magik Autocomplete] Downloading {file_name}",
                        leave=False,
                        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}{postfix}]",
                    ) as pbar,
                ):
                    while True:
                        chunk = response.read(chunk_size)
                        if not chunk:
                            break

                        f_out.write(chunk)
                        downloaded_size += len(chunk)
                        pbar.update(len(chunk))

            sys.stdout.write("\r" + " " * 100 + "\r")
            sys.stdout.flush()

            shutil.move(temp_path, final_path)
            print(f"[Magik Autocomplete] Successfully downloaded and moved {file_name} to {final_path}.")
            metadata_entry["last_download"] = now_utc

        except (urllib.error.URLError, OSError, TimeoutError) as e:
            sys.stdout.write("\n")
            sys.stdout.flush()
            print(f"[Magik Autocomplete] Error downloading {file_name}: {e}")
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                    print(f"[Magik Autocomplete] Removed partially downloaded file from temp: {temp_path}")
                except OSError as rm_e:
                    print(f"[Magik Autocomplete] Error removing temporary file {temp_path}: {rm_e}")

            if os.path.exists(final_path):
                try:
                    file_size_at_final = os.path.getsize(final_path)
                    if (
                        file_size_at_final == 0
                        or (total_size and total_size > 0 and file_size_at_final < total_size)
                        or (not total_size and downloaded_size > 0 and file_size_at_final < downloaded_size)
                    ):
                        os.remove(final_path)
                        print(
                            f"[Magik Autocomplete] Removed potentially corrupted file at final destination: {final_path}"
                        )
                except OSError as rm_e:
                    print(f"[Magik Autocomplete] Error removing potentially corrupted file {final_path}: {rm_e}")

    def _ensure_directories_exist(self):
        """Ensures that DATA_DIR and TEMP_DOWNLOAD_DIR exist."""
        os.makedirs(DATA_DIR, exist_ok=True)
        os.makedirs(TEMP_DOWNLOAD_DIR, exist_ok=True)

    def _remote_check_cooldown_expired(self, dataset_meta: dict, now_utc: datetime) -> bool:
        """Returns True if no remote check has been attempted within REMOTE_CHECK_COOLDOWN."""
        last_check = parse_iso8601_utc(dataset_meta.get("last_remote_check_timestamp"))
        if not last_check:
            return True
        return (now_utc - datetime.fromisoformat(last_check)) >= REMOTE_CHECK_COOLDOWN

    def _check_new_csv_from_hf_dataset(self, dataset_meta: dict, now_utc: datetime, force_check: bool = False):
        """Checks HuggingFace for file updates and updates metadata."""
        perform_hf_check = force_check or self._remote_check_cooldown_expired(dataset_meta, now_utc)

        if perform_hf_check:
            huggingface_dataset_id = dataset_meta["hf_dataset_id"]

            print(f"[Magik Autocomplete] Checking HuggingFace dataset {huggingface_dataset_id} for file updates...")
            # Record the attempt (not only successes) so an unreachable network does not
            # add a timeout to every startup; force_check bypasses the cooldown anyway.
            dataset_meta["last_remote_check_timestamp"] = now_utc.isoformat()

            file_timestamps = self._get_hf_dataset_file_last_modified_map(huggingface_dataset_id)
            for file_meta_info in dataset_meta["csv_files"]:
                file_name_from_meta = file_meta_info.get("file_name")
                if not file_name_from_meta:
                    print("[Magik Autocomplete] Warning: file_name missing in csv_files metadata entry.")
                    continue

                last_modified = file_timestamps.get(file_name_from_meta)
                if last_modified:
                    file_meta_info["last_modified_on_hf"] = last_modified
                else:
                    print(f"[Magik Autocomplete] No lastModified found for {file_name_from_meta} in dataset {huggingface_dataset_id}.")

    def _record_seen_remote_timestamps(self, dataset_meta: dict):
        """
        Marks the currently known remote timestamps as seen. Called after downloads so that
        unchanged remote files are not re-downloaded on later runs.
        """
        for file_meta_info in dataset_meta.get("csv_files", []):
            if file_meta_info.get("last_modified_on_hf"):
                file_meta_info["last_seen_modified_on_hf"] = file_meta_info["last_modified_on_hf"]

    def _download_csv_files_if_needed(self, dataset_meta: dict):
        """Downloads CSV files if they are missing, outdated, or previously failed."""

        for file_meta_entry in dataset_meta["csv_files"]:
            file_name = file_meta_entry.get("file_name")
            if not file_name:
                print("[Magik Autocomplete] Warning: file_name missing in file_meta_entry during download check.")
                continue

            reason_for_download = self.check_csv_file_should_download(file_meta_entry, file_name)

            if reason_for_download:
                print(f"[Magik Autocomplete] Queuing download for {file_name}: {reason_for_download}")
                self._download_file_with_progress_sync(dataset_meta["hf_dataset_id"], file_name, file_meta_entry)

    def check_csv_file_should_download(self, file_meta_entry, file_name):
        """
        Determines if a file should be downloaded based on its metadata and local status.
        Returns a reason string if a download is needed, or None if no action is required.
        """
        local_file_path = get_file_path(file_name)

        # If the CSV_META_FILE was not found initially, we need to download the file.
        if not self.csv_meta_file_exists_at_start:
            return f"{CSV_META_FILE_NAME} was not found initially. Forcing download of {file_name}."

        # If the file is empty or missing, we need to download it.
        if not check_file_valid(local_file_path):
            return f"File {file_name} is missing or empty locally."

        # If the remote file's lastModified changed since the previous check and is newer
        # than the local download, the file needs to be downloaded again. Comparing against
        # last_seen_modified_on_hf (recorded after each check) prevents re-downloading when
        # the remote timestamp is unchanged or bogus.
        raw_hf_modified = file_meta_entry.get("last_modified_on_hf")
        hf_modified = parse_iso8601_utc(raw_hf_modified)
        if hf_modified and raw_hf_modified != file_meta_entry.get("last_seen_modified_on_hf"):
            raw_last_download = file_meta_entry.get("last_download")
            last_download = parse_iso8601_utc(raw_last_download)
            if not last_download:
                return f"Remote file {file_name} changed on HuggingFace (HF: {raw_hf_modified}) and no local download is recorded."
            if datetime.fromisoformat(hf_modified) > datetime.fromisoformat(last_download):
                return f"Remote file {file_name} is newer (HF: {raw_hf_modified}, local download: {raw_last_download})."

        # If the file is missing or empty, but the last download timestamp exists, we need to retry.
        if not check_file_valid(local_file_path) and file_meta_entry.get("last_download") is not None:
            return f"File {file_name} is missing or empty locally, but last download timestamp exists. Retrying."

        return None

    def run_check_and_download(self, force_check: bool = False):
        """
        Orchestrates the process of checking for updates and downloading CSV files.
        This is the main entry point for the downloader logic.

        Args:
            force_check: If True, forces a check of HuggingFace regardless of the last check timestamp.
                Otherwise the remote check runs at most once per REMOTE_CHECK_COOLDOWN.
        """
        # If check_updates_on_startup is False and force_check is not set, skip the check
        if not (self.metadata.get("check_updates_on_startup", True) or force_check):
            print('[Magik Autocomplete] "check_updates_on_startup" is disabled. Skipping CSV update check and download.')
            return

        now_utc = datetime.now(timezone.utc)

        datasets_meta = self.metadata.get("hf_datasets", [])
        for dataset_meta in datasets_meta:
            self._check_new_csv_from_hf_dataset(dataset_meta, now_utc, force_check)
            self._download_csv_files_if_needed(dataset_meta)
            self._record_seen_remote_timestamps(dataset_meta)

        self._save_metadata()
