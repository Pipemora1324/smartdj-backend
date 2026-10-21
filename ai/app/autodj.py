# AutoDJ: elige la siguiente pista de la emisora entre las candidatas (rpc SuggestNext y POST /suggest-next).
# Reutiliza las familias de género, el BPM y la tonalidad del motor de compatibilidad (engine.py).
from app.engine import NEUTRAL, VENUE_PROFILES, bpm_score, family, family_affinity, key_score, normalize

# Energía objetivo por tipo de local (1 muy tranquila … 5 muy enérgica). Jamendo la da como "speed".
VENUE_ENERGY = {'restaurant': (2, 3), 'cafe': (2, 3), 'lounge': (2, 3), 'salsa_bar': (3, 4), 'nightclub': (4, 5), 'other': (3, 3)}
WEIGHTS = {'genre': .35, 'energy': .25, 'flow': .15, 'bpm': .15, 'key': .10}
REPEATED_ARTIST_PENALTY = .2
MIN_CROSSFADE, MAX_CROSSFADE = 6.0, 12.0
MIN_TRANSITION = 30.0
MAX_CANDIDATES = 200


def energy_target_score(venue_type, energy):
    """1 si la energía está en el rango del local; baja 0,5 por cada nivel fuera de él."""
    if not energy:
        return NEUTRAL
    low, high = VENUE_ENERGY.get(venue_type, VENUE_ENERGY['other'])
    if low <= energy <= high:
        return 1.0
    return max(0.0, 1 - min(abs(energy - low), abs(energy - high)) / 2)


def energy_flow_score(current_energy, energy):
    """Continuidad: subir o bajar un nivel está bien; saltar dos o más corta el ambiente."""
    if not current_energy or not energy:
        return NEUTRAL
    return {0: 1.0, 1: 0.85, 2: 0.4}.get(abs(current_energy - energy), 0.1)


def genre_fit(venue_type, current_genre, genre):
    """Mitad afinidad con el perfil del local, mitad continuidad con la pista anterior."""
    profile = VENUE_PROFILES.get(venue_type)
    venue = family_affinity(profile, family(genre)) if profile else 0.8
    flow = family_affinity(family(current_genre), family(genre)) if normalize(current_genre) else venue
    return 0.5 * venue + 0.5 * flow


def crossfade_for(energy, bpm, duration):
    """Más largo con energía baja (mezcla suave), más corto con energía o tempo altos; nunca más de un tercio de la pista."""
    seconds = MAX_CROSSFADE - 1.5 * (energy - 1) if energy else 8.0
    if bpm and bpm >= 120:
        seconds -= 1.5
    seconds = min(MAX_CROSSFADE, max(MIN_CROSSFADE, seconds))
    if duration > 0:
        seconds = min(seconds, duration / 3)
    return round(seconds, 1)


def transition_point(duration, crossfade):
    """Segundo de la pista en el que empieza el crossfade hacia la siguiente (antes del final, nunca demasiado pronto)."""
    if duration <= 0:
        return 0.0
    return round(max(min(MIN_TRANSITION, duration / 2), duration - crossfade - 1), 1)


def score_candidate(venue_type, current, candidate, recent_artists):
    parts = {
        'genre': genre_fit(venue_type, current.get('genre', ''), candidate.get('genre', '')),
        'energy': energy_target_score(venue_type, candidate.get('energy', 0)),
        'flow': energy_flow_score(current.get('energy', 0), candidate.get('energy', 0)),
        'bpm': bpm_score(current.get('bpm', 0), candidate.get('bpm', 0)),
        'key': key_score(current.get('key', ''), candidate.get('key', '')),
    }
    score = sum(WEIGHTS[name] * value for name, value in parts.items())
    repeated = normalize(candidate.get('artist', '')) in recent_artists
    if repeated:
        score -= REPEATED_ARTIST_PENALTY
    return max(0.0, score), parts, repeated


def describe(venue_type, current, candidate, parts, repeated):
    """Razón en español con lo que más pesó en la elección."""
    reasons = []
    if parts['energy'] >= 1 and candidate.get('energy'):
        reasons.append(f"energía {candidate['energy']}/5, la del local")
    if normalize(current.get('genre', '')) and family(current.get('genre')) == family(candidate.get('genre', '')) != 'other':
        reasons.append(f"sigue el estilo de la anterior ({candidate.get('genre')})")
    elif parts['genre'] >= 0.8 and candidate.get('genre'):
        reasons.append(f"el género {candidate.get('genre')} encaja con el local")
    if parts['flow'] >= 0.85 and current.get('energy') and candidate.get('energy'):
        reasons.append('transición de energía suave')
    if parts['bpm'] >= 0.8 and current.get('bpm') and candidate.get('bpm'):
        reasons.append(f"tempo parecido ({round(candidate['bpm'])} BPM)")
    if parts['key'] >= 0.85 and current.get('key') and candidate.get('key'):
        reasons.append('tonalidad compatible')
    if repeated:
        reasons.append('el artista sonó hace poco')
    text = ', '.join(reasons) if reasons else 'la mejor opción disponible para el ambiente del local'
    return text[0].upper() + text[1:] + '.'


def suggest_next(venue_type, current, candidates, recent_ids=(), recent_artists=()):
    """Devuelve la mejor candidata con puntaje (0-100), razón, punto de transición y crossfade, o None si no hay.
    No repite pistas recientes; si todas son recientes, repite antes que dejar la emisora en silencio."""
    current = current or {}
    recent = set(recent_ids) | ({current['id']} if current.get('id') else set())
    artists = {normalize(a) for a in recent_artists if a}
    pool = [c for c in candidates if c.get('id') and c['id'] not in recent]
    if not pool:
        pool = [c for c in candidates if c.get('id') and c['id'] != current.get('id')]
    if not pool:
        return None
    best = None
    for candidate in pool:
        score, parts, repeated = score_candidate(venue_type, current, candidate, artists)
        if best is None or score > best[0]:
            best = (score, candidate, parts, repeated)
    score, chosen, parts, repeated = best
    duration = float(chosen.get('duration_seconds') or 0)
    crossfade = crossfade_for(chosen.get('energy', 0), chosen.get('bpm', 0), duration)
    return {
        'track_id': chosen['id'],
        'score': round(score * 100),
        'reason': describe(venue_type, current, chosen, parts, repeated),
        'transition_at_seconds': transition_point(duration, crossfade),
        'crossfade_seconds': crossfade,
    }
