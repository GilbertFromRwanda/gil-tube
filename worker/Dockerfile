FROM golang:1.25-alpine

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .

RUN go build -o /bin/gil-tube-worker .

CMD ["/bin/gil-tube-worker"]
