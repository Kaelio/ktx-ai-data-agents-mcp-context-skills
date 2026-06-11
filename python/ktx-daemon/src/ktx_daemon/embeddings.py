"""Portable embedding compute helpers for ktx daemon."""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Protocol

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

DEFAULT_SENTENCE_TRANSFORMER_MODEL = "all-MiniLM-L6-v2"
DEFAULT_EMBEDDING_DIMENSIONS = 384
DEFAULT_MAX_BATCH_SIZE = 100


class EmbeddingProvider(Protocol):
    """Provider interface for local embedding compute."""

    @property
    def name(self) -> str: ...

    @property
    def dimensions(self) -> int: ...

    @property
    def max_batch_size(self) -> int: ...

    def encode(self, texts: list[str]) -> list[list[float]]: ...


class ComputeEmbeddingRequest(BaseModel):
    """Request schema for computing a single embedding."""

    text: str = Field(..., description="Text to compute embedding for", min_length=1)


class ComputeEmbeddingResponse(BaseModel):
    """Response schema for single embedding computation."""

    embedding: list[float] = Field(..., description="384-dimensional embedding vector")


class ComputeEmbeddingBulkRequest(BaseModel):
    """Request schema for computing multiple embeddings."""

    texts: list[str] = Field(
        ...,
        description="List of texts to compute embeddings for",
        min_length=1,
        max_length=DEFAULT_MAX_BATCH_SIZE,
    )


class ComputeEmbeddingBulkResponse(BaseModel):
    """Response schema for bulk embedding computation."""

    embeddings: list[list[float]] = Field(
        ...,
        description="List of 384-dimensional embedding vectors",
    )


class SentenceTransformersEmbeddingProvider:
    """Lazy sentence-transformers provider for local embeddings."""

    def __init__(
        self,
        model_name: str = DEFAULT_SENTENCE_TRANSFORMER_MODEL,
        model: SentenceTransformer | None = None,
    ) -> None:
        self.model_name = model_name
        self._model = model
        self._model_lock = threading.Lock()

    @property
    def name(self) -> str:
        return "sentence-transformers"

    @property
    def dimensions(self) -> int:
        return DEFAULT_EMBEDDING_DIMENSIONS

    @property
    def max_batch_size(self) -> int:
        return DEFAULT_MAX_BATCH_SIZE

    def _get_model(self) -> SentenceTransformer:
        if self._model is not None:
            return self._model

        with self._model_lock:
            if self._model is None:
                from sentence_transformers import SentenceTransformer

                logger.info("Loading SentenceTransformer model: %s", self.model_name)
                self._model = SentenceTransformer(self.model_name)
                logger.info("SentenceTransformer model loaded successfully")

        return self._model

    def encode(self, texts: list[str]) -> list[list[float]]:
        model = self._get_model()
        if len(texts) == 1:
            raw_single = model.encode(texts[0]).tolist()
            return [[float(value) for value in raw_single]]

        raw_bulk = model.encode(texts).tolist()
        return [[float(value) for value in embedding] for embedding in raw_bulk]


_default_provider: SentenceTransformersEmbeddingProvider | None = None
_default_provider_lock = threading.Lock()


def get_default_embedding_provider() -> SentenceTransformersEmbeddingProvider:
    """Return the process-wide default embedding provider."""

    global _default_provider

    if _default_provider is not None:
        return _default_provider

    with _default_provider_lock:
        if _default_provider is None:
            _default_provider = SentenceTransformersEmbeddingProvider()

    return _default_provider


def _validate_texts(texts: list[str], max_batch_size: int) -> None:
    if not texts:
        raise ValueError("Texts array must not be empty")
    if len(texts) > max_batch_size:
        raise ValueError(f"Maximum {max_batch_size} texts allowed per batch")

    empty_indices = [
        index for index, text in enumerate(texts) if not text or not text.strip()
    ]
    if empty_indices:
        joined_indices = ", ".join(str(index) for index in empty_indices)
        raise ValueError(f"Empty texts found at indices: {joined_indices}")


def compute_embedding_response(
    request: ComputeEmbeddingRequest,
    provider: EmbeddingProvider | None = None,
) -> ComputeEmbeddingResponse:
    """Compute one embedding from a request model."""

    selected_provider = provider or get_default_embedding_provider()
    _validate_texts([request.text], selected_provider.max_batch_size)
    return ComputeEmbeddingResponse(
        embedding=selected_provider.encode([request.text])[0]
    )


def compute_embedding_bulk_response(
    request: ComputeEmbeddingBulkRequest,
    provider: EmbeddingProvider | None = None,
) -> ComputeEmbeddingBulkResponse:
    """Compute multiple embeddings from a request model."""

    selected_provider = provider or get_default_embedding_provider()
    _validate_texts(request.texts, selected_provider.max_batch_size)
    return ComputeEmbeddingBulkResponse(
        embeddings=selected_provider.encode(request.texts)
    )
