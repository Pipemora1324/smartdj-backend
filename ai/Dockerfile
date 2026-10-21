FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# ffmpeg: librosa lo necesita para decodificar los previews .m4a de iTunes en /analyze.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY proto ./proto
EXPOSE 8000 50051
CMD ["python", "-m", "app.serve"]
