from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Optional
import os
from app.autodj import MAX_CANDIDATES, suggest_next
from app.engine import evaluate

app = FastAPI(title='Smart DJ Engine', version='1.0.0')
class Compatibility(BaseModel):
    venue_type: str = 'other'; current_genre: str = ''; requested_genre: str
    current_bpm: float = Field(default=0, ge=0, le=300); requested_bpm: float = Field(default=0, ge=0, le=300)
    current_key: str = ''; requested_key: str = ''
# AutoDJ por HTTP (mismo cálculo que el rpc SuggestNext, para el modo sin gRPC).
class TrackFeatures(BaseModel):
    id: str = ''; genre: str = ''; bpm: float = Field(default=0, ge=0, le=300); key: str = ''
    energy: int = Field(default=0, ge=0, le=5); duration_seconds: float = Field(default=0, ge=0); artist: str = ''
class SuggestNext(BaseModel):
    venue_type: str = 'other'; current: Optional[TrackFeatures] = None
    candidates: List[TrackFeatures] = Field(default_factory=list, max_length=MAX_CANDIDATES)
    recent_ids: List[str] = Field(default_factory=list); recent_artists: List[str] = Field(default_factory=list)
    request_genres: List[str] = Field(default_factory=list); request_artists: List[str] = Field(default_factory=list)
@app.get('/health')
def health(): return {'status':'ok','engine':'heuristic','grpc':bool(os.environ.get('AI_GRPC_PORT'))}
@app.post('/compatibility')
def compatibility(data: Compatibility):
    return evaluate(data.venue_type,data.current_genre,data.requested_genre,data.current_bpm,data.requested_bpm,data.current_key,data.requested_key)
@app.post('/suggest-next')
def suggest(data: SuggestNext):
    current = data.current.model_dump() if data.current and data.current.id else None
    result = suggest_next(data.venue_type, current, [c.model_dump() for c in data.candidates], data.recent_ids, data.recent_artists,
                          data.request_genres, data.request_artists)
    return result or {'track_id': '', 'score': 0, 'reason': 'No hay candidatas disponibles.', 'transition_at_seconds': 0, 'crossfade_seconds': 0}
