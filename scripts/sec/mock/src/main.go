package main

import (
	"fmt"

	"github.com/google/uuid"
)

func main() {
	id := uuid.New()
	fmt.Println("ID:", id)
}

func greet(name string) string {
	return "Hello, " + name
}
