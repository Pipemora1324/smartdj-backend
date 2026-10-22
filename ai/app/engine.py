# Lógica de compatibilidad compartida por la API HTTP (main.py) y el servidor gRPC (grpc_server.py).
# Es la misma heurística que tenía main.py; los ajustes del motor quedan para la Fase 5.
import re
import unicodedata

# Familias de género. Cada género se clasifica por palabra completa (sin acentos ni mayúsculas);
# si aparecen varias, gana la última ("indie rock" es rock, "latin pop" es pop).
FAMILY_KEYWORDS = {
    'urban': ['reggaeton', 'urbano', 'hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'r&b', 'rnb', 'dancehall', 'dembow'],
    'salsa': ['salsa', 'tropical', 'bachata', 'merengue', 'cumbia', 'vallenato', 'timba', 'champeta', 'son cubano', 'latin', 'latina'],
    'dance': ['electronica', 'electronic', 'edm', 'house', 'techno', 'trance', 'dance', 'disco'],
    'pop': ['pop', 'k-pop', 'balada', 'baladas'],
    'chill': ['jazz', 'lofi', 'lo-fi', 'acoustic', 'acustica', 'soul', 'bossa nova', 'chill', 'ambient', 'indie', 'lounge', 'chillout', 'downtempo'],
    'rock': ['rock', 'alternativo', 'alternative', 'metal', 'punk', 'blues', 'funk', 'grunge'],
}
# Afinidad entre familias distintas (0 a 1); lo que no aparece se considera incompatible.
FAMILY_AFFINITY = {
    frozenset(('salsa', 'urban')): 0.6, frozenset(('salsa', 'pop')): 0.55,
    frozenset(('urban', 'pop')): 0.65, frozenset(('urban', 'dance')): 0.55,
    frozenset(('dance', 'pop')): 0.7, frozenset(('pop', 'chill')): 0.5,
    frozenset(('pop', 'rock')): 0.5, frozenset(('chill', 'rock')): 0.45,
}
UNKNOWN_FAMILY = 'other'
VENUE_PROFILES = {'restaurant': 'chill', 'cafe': 'chill', 'salsa_bar': 'salsa', 'nightclub': 'dance', 'lounge': 'chill', 'other': None}
ACCEPT_THRESHOLD = 72
NEUTRAL = 0.55         # puntaje cuando falta un dato (BPM o tonalidad desconocidos)
BPM_TOLERANCE = 45     # diferencia de BPM con la que el puntaje llega a 0
WEIGHTS = {'genre': .42, 'bpm': .30, 'key': .18, 'venue': .10}

_KEYWORD_PATTERNS = [
    (family, re.compile(r'(?<![a-z0-9&])' + re.escape(word) + r'(?![a-z0-9&])'))
    for family, words in FAMILY_KEYWORDS.items() for word in words
]


def normalize(text):
    text = unicodedata.normalize('NFD', str(text or '')).encode('ascii', 'ignore').decode('ascii')
    return ' '.join(text.lower().replace('/', ' ').replace('_', ' ').split())


def family(genre):
    """Familia del género o 'other' si no se reconoce."""
    text = normalize(genre)
    best = None  # (posición donde termina la coincidencia, largo, familia)
    for name, pattern in _KEYWORD_PATTERNS:
        for match in pattern.finditer(text):
            candidate = (match.end(), match.end() - match.start(), name)
            if best is None or candidate > best:
                best = candidate
    return best[2] if best else UNKNOWN_FAMILY


def family_affinity(a, b):
    if a == b and a != UNKNOWN_FAMILY:
        return 1.0
    if UNKNOWN_FAMILY in (a, b):
        return 0.5
    return FAMILY_AFFINITY.get(frozenset((a, b)), 0.15)


# ---------- Tonalidades (rueda Camelot) ----------
_PITCHES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
_KEY_RE = re.compile(r'^([A-Ga-g])\s*([#b]?)\s*(m|min|minor|menor|maj|major|mayor|M)?$')
_CAMELOT_RE = re.compile(r'^(1[0-2]|[1-9])\s*([ABab])$')
_MINOR_WORDS = {'m', 'min', 'minor', 'menor'}


def parse_key(text):
    """Tonalidad → (número Camelot 1-12, 'A' menor / 'B' mayor), o None si no se reconoce.
    Acepta C, C#, Db, Am, Bbm, F# menor, Eb mayor, 8A, 8B, con ♯ y ♭."""
    raw = str(text or '').strip().replace('♯', '#').replace('♭', 'b')
    camelot = _CAMELOT_RE.match(raw)
    if camelot:
        return int(camelot.group(1)), camelot.group(2).upper()
    match = _KEY_RE.match(raw)
    if not match:
        return None
    letter, accidental, mode = match.groups()
    pitch = (_PITCHES[letter.upper()] + (1 if accidental == '#' else -1 if accidental == 'b' else 0)) % 12
    minor = mode is not None and mode != 'M' and mode.lower() in _MINOR_WORDS
    major_pitch = (pitch + 3) % 12 if minor else pitch  # la relativa mayor comparte número en la rueda
    return (major_pitch * 7 + 7) % 12 + 1, 'A' if minor else 'B'


def key_score(current_key, requested_key):
    """1 si es la misma tonalidad; 0,9 la relativa; 0,85 vecina en la rueda; baja con la distancia."""
    a, b = parse_key(current_key), parse_key(requested_key)
    if not a or not b:
        return NEUTRAL
    steps = abs(a[0] - b[0])
    steps = min(steps, 12 - steps)
    same_mode = a[1] == b[1]
    if steps == 0:
        return 1.0 if same_mode else 0.9
    if steps == 1:
        return 0.85 if same_mode else 0.6
    return round(max(0.05, 0.6 * (1 - steps / 6)), 4)


def bpm_score(current_bpm, requested_bpm):
    """Tolera medio y doble tempo; 0 o vacío significa BPM desconocido."""
    if not current_bpm or not requested_bpm:
        return NEUTRAL
    diff = min(abs(current_bpm - requested_bpm), abs(current_bpm - 2 * requested_bpm), abs(2 * current_bpm - requested_bpm))
    return max(0, 1 - diff / BPM_TOLERANCE)


def venue_score(venue_type, requested_genre):
    profile = VENUE_PROFILES.get(venue_type)
    if profile is None:
        return 0.8
    return family_affinity(profile, family(requested_genre))


def genre_score(current_genre, requested_genre):
    return family_affinity(family(current_genre), family(requested_genre))


def build_result(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, scores):
    """Combina los puntajes de cada etapa en el resultado final (aceptación, motivo y puente)."""
    has_current = bool(normalize(current_genre))
    score = round(100 * sum(WEIGHTS[name] * scores[name] for name in WEIGHTS))
    accepted = score >= ACCEPT_THRESHOLD
    bridge = []
    if not accepted and has_current:
        current, requested = family(current_genre), family(requested_genre)
        for step in (1, 2):
            target = round(current_bpm + (requested_bpm - current_bpm) * step / 3) if current_bpm and requested_bpm else 0
            bridge.append({'position': step, 'genre': current if step == 1 else requested, 'target_bpm': target, 'purpose': 'Ajustar energía y tempo de forma gradual'})
    if accepted:
        reason = 'La canción encaja directamente con el ambiente.' if has_current else 'No hay canción sonando: la canción encaja con el ambiente del local.'
    elif has_current:
        reason = f'Transición directa no recomendada ({score}/100). Se generó un puente de {len(bridge)} temas.'
    else:
        reason = f'No encaja bien con el ambiente del local ({score}/100). El DJ decidirá si la pone.'
    return {'accepted': accepted, 'score': score, 'reason': reason, 'bridge_sequence': bridge, 'profile': VENUE_PROFILES.get(venue_type) or 'libre'}


def stage_scores(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, current_key, requested_key):
    """Puntaje de cada etapa. Sin canción sonando, el género se compara con el perfil del local."""
    has_current = bool(normalize(current_genre))
    return {
        'genre': genre_score(current_genre, requested_genre) if has_current else venue_score(venue_type, requested_genre),
        'bpm': bpm_score(current_bpm, requested_bpm),
        'key': key_score(current_key, requested_key),
        'venue': venue_score(venue_type, requested_genre),
    }


def evaluate(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, current_key, requested_key):
    """Evaluación completa en un solo paso (la usan POST /compatibility y CheckCompatibility)."""
    scores = stage_scores(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, current_key, requested_key)
    return build_result(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, scores)
