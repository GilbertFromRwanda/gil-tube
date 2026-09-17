FROM golang:1.25-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .

RUN go build -o /bin/gil-tube-api .

EXPOSE 8080

CMD ["/bin/gil-tube-api"]
