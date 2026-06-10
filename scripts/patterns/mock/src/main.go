package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
)

// command-injection-go
func runShellConcat(userInput string) {
	exec.Command("sh " + userInput)
}

func runSprintf(name string) {
	exec.Command(fmt.Sprintf("echo %s", name))
}

// path-traversal-go
func openUserFile(path string) {
	os.Open(path)
}

func readUserFile(path string) {
	ioutil.ReadFile(path)
}

func readFileNew(path string) {
	os.ReadFile(path)
}

func main() {
	fmt.Println("mock")
}
