from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
import tempfile, os
from app.autodj import MAX_CANDIDATES, suggest_next
from app.engine import evaluate
from app.safe_fetch import UnsafeUrlError, download

app = FastAPI(title='Smart DJ Engine', version='1.0.0')
class Compatibility(BaseModel):
    venue_type: str = 'other'; current_genre: str = ''; requested_genre: str
    current_bpm: float = Field(default=0, ge=0, le=300); requested_bpm: float = Field(default=0, ge=0, le=300)
    current_key: str = ''; requested_key: str = ''
class Analysis(BaseModel): audio_url: str
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
def health(): return {'status':'ok','engine':'heuristic+librosa','grpc':bool(os.environ.get('AI_GRPC_PORT'))}
@app.post('/compatibility')
def compatibility(data: Compatibility):
    return evaluate(data.venue_type,data.current_genre,data.requested_genre,data.current_bpm,data.requested_bpm,data.current_key,data.requested_key)
@app.post('/suggest-next')
def suggest(data: SuggestNext):
    current = data.current.model_dump() if data.current and data.current.id else None
    result = suggest_next(data.venue_type, current, [c.model_dump() for c in data.candidates], data.recent_ids, data.recent_artists,
                          data.request_genres, data.request_artists)
    return result or {'track_id': '', 'score': 0, 'reason': 'No hay candidatas disponibles.', 'transition_at_seconds': 0, 'crossfade_seconds': 0}
@app.post('/analyze')
def analyze(payload: Analysis):
    # Analizar audio con librosa usa unos 400 MB: se importa solo aquí y se puede apagar con
    # AI_ENABLE_ANALYZE=false (el contenedor combinado de Render gratis lo apaga).
    if os.environ.get('AI_ENABLE_ANALYZE', 'true').lower() != 'true':
        raise HTTPException(503, detail='El análisis de audio está desactivado en este despliegue.')
    import librosa, numpy as np
    path=None
    try:
        content=download(payload.audio_url)
        suffix='.audio'; f=tempfile.NamedTemporaryFile(delete=False,suffix=suffix); f.write(content); f.close(); path=f.name
        y,sr=librosa.load(f.name,mono=True,duration=90)
        tempo=float(librosa.beat.tempo(y=y,sr=sr)[0]); chroma=librosa.feature.chroma_cqt(y=y,sr=sr); key=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][int(np.argmax(chroma.mean(axis=1)))]
        return {'bpm':round(tempo,2),'key':key,'duration_analyzed_seconds':round(len(y)/sr,2)}
    except UnsafeUrlError as exc: raise HTTPException(400,detail=str(exc))
    except Exception as exc: raise HTTPException(422,detail=f'No se pudo analizar el audio: {str(exc)}')
    finally:
        if path and os.path.exists(path): os.unlink(path)
