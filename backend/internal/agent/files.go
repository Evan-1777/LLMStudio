// Package agent implements the native tools and workspace policy of an execution endpoint.
package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"llmstudio/backend/internal/plugin"
)

const (
	maxFile    = 2 << 20
	maxOutput  = 32 << 10
	maxEntries = 200
)

func schema(required []string, properties map[string]string) json.RawMessage {
	fields := make(map[string]map[string]string, len(properties))
	for name, kind := range properties {
		fields[name] = map[string]string{"type": kind}
	}
	data, _ := json.Marshal(map[string]any{"type": "object", "properties": fields, "required": required, "additionalProperties": false})
	return data
}

var fileTools = []plugin.ChatTool{
	{Alias: "read", Description: "Read UTF-8 text from a workspace-relative path. offset is a 1-based line; limit is a line count.", InputSchema: schema([]string{"path"}, map[string]string{"path": "string", "offset": "integer", "limit": "integer"})},
	{Alias: "ls", Description: "List entries in a workspace-relative directory (default: workspace root).", InputSchema: schema([]string{}, map[string]string{"path": "string"})},
	{Alias: "find", Description: "Find files under path (default: root) matching a glob like *.go or src/**/*.go.", InputSchema: schema([]string{"pattern"}, map[string]string{"path": "string", "pattern": "string"})},
	{Alias: "grep", Description: "Search UTF-8 files under path (default: root). The pattern is literal unless regex is true. Optional glob filters file names.", InputSchema: schema([]string{"pattern"}, map[string]string{"path": "string", "pattern": "string", "regex": "boolean", "glob": "string"})},
	{Alias: "write", Description: "Create or replace a UTF-8 text file in the workspace. The parent must already exist.", InputSchema: schema([]string{"path", "content"}, map[string]string{"path": "string", "content": "string"})},
	{Alias: "edit", Description: "Replace exactly one occurrence of oldText with newText in a workspace text file.", InputSchema: schema([]string{"path", "oldText", "newText"}, map[string]string{"path": "string", "oldText": "string", "newText": "string"})},
}

func relative(path string) (string, error) {
	if path == "" {
		return ".", nil
	}
	if !filepath.IsLocal(path) || strings.ContainsAny(path, "\\:\x00") || strings.Contains("/"+path+"/", "/../") {
		return "", errors.New("path must be relative to the workspace")
	}
	return filepath.Clean(filepath.FromSlash(path)), nil
}

type fileArgs struct {
	Path                      string
	Offset, Limit             int
	Pattern, Glob             string
	Regex                     bool
	Content, OldText, NewText *string
}

func runFile(ctx context.Context, root *os.Root, name string, raw json.RawMessage) (string, error) {
	var args fileArgs
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return "", errors.New("invalid file tool arguments")
	}
	path, err := relative(args.Path)
	if err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	var out output
	switch name {
	case "read":
		if args.Offset < 0 || args.Limit < 0 {
			return "", errors.New("offset and limit must be nonnegative")
		}
		data, err := readText(root, path)
		if err != nil {
			return "", err
		}
		offset, limit := max(args.Offset, 1), args.Limit
		if limit == 0 {
			limit = maxEntries
		}
		i := 0
		for line := range strings.SplitSeq(strings.TrimSuffix(string(data), "\n"), "\n") {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			i++
			if i < offset {
				continue
			}
			if i-offset >= limit || !out.add(fmt.Sprintf("%d: %s", i, line)) {
				break
			}
		}
	case "ls":
		if info, err := root.Stat(path); err != nil || !info.IsDir() {
			return "", errors.New("not an accessible workspace directory")
		}
		f, err := root.Open(path)
		if err != nil {
			return "", err
		}
		defer f.Close()
		for !out.full() {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			entries, err := f.ReadDir(32)
			for _, entry := range entries {
				name := entry.Name()
				if entry.IsDir() {
					name += "/"
				}
				if !out.add(name) {
					break
				}
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return "", err
			}
		}
	case "find", "grep":
		pattern := args.Glob
		if name == "find" {
			pattern = args.Pattern
		}
		if args.Pattern == "" {
			return "", errors.New("pattern is required")
		}
		match, err := globMatcher(pattern)
		if err != nil {
			return "", err
		}
		contains := func(s string) bool { return strings.Contains(s, args.Pattern) }
		if name == "grep" && args.Regex {
			re, err := regexp.Compile(args.Pattern)
			if err != nil {
				return "", err
			}
			contains = re.MatchString
		}
		err = fs.WalkDir(root.FS(), filepath.ToSlash(path), func(p string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if out.full() {
				return errOutputLimit
			}
			if err != nil {
				if p == filepath.ToSlash(path) {
					return err
				}
				return nil
			}
			if d.IsDir() || !d.Type().IsRegular() || !match(p) {
				return nil
			}
			if name == "find" {
				out.add(p)
				return nil
			}
			data, err := readText(root, filepath.FromSlash(p))
			if err != nil {
				return nil
			}
			scanner := bufio.NewScanner(strings.NewReader(string(data)))
			scanner.Buffer(make([]byte, 4096), maxFile+1)
			for line := 1; scanner.Scan(); line++ {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if contains(scanner.Text()) && !out.add(fmt.Sprintf("%s:%d: %s", p, line, scanner.Text())) {
					return errOutputLimit
				}
			}
			return scanner.Err()
		})
		if err != nil && !errors.Is(err, errOutputLimit) {
			return "", err
		}
	case "write", "edit":
		var text string
		if name == "write" {
			if args.Content == nil {
				return "", errors.New("content is required")
			}
			text = *args.Content
		} else {
			if args.OldText == nil || *args.OldText == "" || args.NewText == nil {
				return "", errors.New("oldText and newText are required")
			}
			data, err := readText(root, path)
			if err != nil {
				return "", err
			}
			before := string(data)
			first := strings.Index(before, *args.OldText)
			if first < 0 || strings.Contains(before[first+1:], *args.OldText) {
				return "", errors.New("oldText must match exactly once")
			}
			text = strings.Replace(before, *args.OldText, *args.NewText, 1)
		}
		if err := writeText(ctx, root, path, text); err != nil {
			return "", err
		}
		return fmt.Sprintf("%s (%d bytes)", filepath.ToSlash(path), len(text)), nil
	}
	return out.text(), nil
}

// A glob without a slash matches basenames at any depth; ** matches directory segments.
func globMatcher(pattern string) (func(string) bool, error) {
	if pattern == "" {
		return func(string) bool { return true }, nil
	}
	if len(pattern) > 4096 {
		return nil, errors.New("glob is too long")
	}
	parts := strings.Split(pattern, "/")
	for _, part := range parts {
		if _, err := filepath.Match(part, ""); err != nil {
			return nil, err
		}
	}
	return func(p string) bool {
		if len(parts) == 1 {
			ok, _ := filepath.Match(pattern, filepath.Base(p))
			return ok
		}
		names := strings.Split(p, "/")
		i, j := 0, 0
		star, next := -1, 0
		for j < len(names) {
			if i < len(parts) {
				if parts[i] == "**" {
					star, next = i, j
					i++
					continue
				}
				if ok, _ := filepath.Match(parts[i], names[j]); ok {
					i++
					j++
					continue
				}
			}
			if star < 0 {
				return false
			}
			next++
			i, j = star+1, next
		}
		for i < len(parts) && parts[i] == "**" {
			i++
		}
		return i == len(parts)
	}, nil
}

func readText(root *os.Root, path string) ([]byte, error) {
	info, err := root.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFile {
		return nil, errors.New("not a text file within the size limit")
	}
	f, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("not a regular text file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFile || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return nil, errors.New("not a UTF-8 text file within the size limit")
	}
	return data, nil
}

func writeText(ctx context.Context, root *os.Root, path, text string) error {
	if len(text) > maxFile || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return errors.New("content must be UTF-8 text within the size limit")
	}
	mode := fs.FileMode(0600)
	if info, err := root.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("destination is not a regular file")
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var id [12]byte
	rand.Read(id[:])
	tmp := filepath.Join(filepath.Dir(path), ".llmstudio-"+hex.EncodeToString(id[:]))
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, writeErr := io.WriteString(f, text)
	if err := errors.Join(writeErr, f.Close()); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return root.Rename(tmp, path)
}

var errOutputLimit = errors.New("output limit reached")

type output struct {
	strings.Builder
	entries   int
	truncated bool
}

func (o *output) full() bool {
	if o.entries >= maxEntries {
		o.truncated = true
	}
	return o.truncated
}
func (o *output) add(line string) bool {
	if o.full() {
		return false
	}
	budget := maxOutput - 32 - o.Len()
	if len(line)+1 > budget {
		if budget > 0 {
			o.WriteString(strings.ToValidUTF8(line[:budget], ""))
		}
		o.truncated = true
		return false
	}
	o.WriteString(line)
	o.WriteByte('\n')
	o.entries++
	return true
}
func (o *output) text() string {
	if o.truncated {
		return o.String() + "\n[output truncated]"
	}
	return strings.TrimSuffix(o.String(), "\n")
}
