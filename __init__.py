"""Magik Autocomplete: tag completion, related tags, formatting and custom widgets."""
from .modules import api, downloader

dl = downloader.Downloader()
dl.run_check_and_download()

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
