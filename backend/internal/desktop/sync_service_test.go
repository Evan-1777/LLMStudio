package desktop

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestSyncServiceBidirectionalAndConflictHandling(t *testing.T) {
	ctx := context.Background()

	// Cloud gateway DB & router.
	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud db: %v", err)
	}
	defer cloudDB.Close()

	cloudAssistStore := store.NewAssistantStore(cloudDB)
	cloudConvStore := store.NewConversationStore(cloudDB)
	cloudMsgStore := store.NewMessageStore(cloudDB)
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:              config.Config{AccessToken: "sync-tok", DevMode: false},
		AssistantService:    service.NewAssistantService(cloudAssistStore),
		ConversationService: service.NewConversationService(cloudConvStore, cloudMsgStore).WithAssistants(cloudAssistStore),
	})
	cloudSrv := httptest.NewServer(cloudRouter)
	defer cloudSrv.Close()

	// Desktop local DB.
	localStore, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "local-sync.db"))
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	cloud := NewCloudClient(cloudSrv.URL, "sync-tok")
	syncSvc := NewSyncService(localStore, cloud)

	// 1. Upload local conversation with group (not migrated), pinned state, text & image blocks.
	localGrp, err := localStore.Conversations.CreateGroup(ctx, domain.DefaultAssistantID, "Local Folder")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	localConv, err := localStore.Conversations.Create(ctx, domain.Conversation{
		ID:          "up-1",
		AssistantID: domain.DefaultAssistantID,
		Title:       "Local With Image",
		GroupID:     &localGrp.ID,
		Pinned:      true,
	})
	if err != nil {
		t.Fatalf("create local conv: %v", err)
	}
	if _, err := localStore.Messages.Create(ctx, domain.Message{
		ConversationID: localConv.ID,
		Role:           domain.RoleUser,
		Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "iVBORw0KGgo="},
			{Type: domain.BlockTypeText, Text: "see attachment"},
		},
	}); err != nil {
		t.Fatalf("create local msg: %v", err)
	}

	upRes, err := syncSvc.UploadConversation(ctx, localConv.ID, false)
	if err != nil {
		t.Fatalf("UploadConversation: %v", err)
	}
	if upRes.Conversation.GroupID != nil || !upRes.Conversation.Pinned || len(upRes.Messages) != 1 || upRes.Messages[0].Blocks[0].Type != domain.BlockTypeImage {
		t.Fatalf("unexpected upload result: %+v", upRes)
	}
	localAfterUp, _ := localStore.Conversations.Get(ctx, localConv.ID)
	if localAfterUp.SyncState != domain.SyncStateSynced || localAfterUp.GroupID == nil {
		t.Fatalf("expected local source preserved & marked synced, got %+v", localAfterUp)
	}

	// Idempotent second upload without edits produces no duplicates.
	if _, err := syncSvc.UploadConversation(ctx, localConv.ID, false); err != nil {
		t.Fatalf("idempotent re-upload failed: %v", err)
	}
	cloudConvs, _ := cloudConvStore.List(ctx)
	if len(cloudConvs) != 1 {
		t.Fatalf("expected 1 cloud conversation after idempotent upload, got %d", len(cloudConvs))
	}

	// Modify cloud copy -> upload without force returns 409 CONFLICT; force=true overwrites.
	if _, err := cloudMsgStore.Create(ctx, domain.Message{
		ConversationID: localConv.ID,
		Role:           domain.RoleAssistant,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "web edit"}},
	}); err != nil {
		t.Fatalf("cloud Create message: %v", err)
	}
	if err := cloudConvStore.TouchUpdatedAt(ctx, localConv.ID, time.Now().UTC().Add(time.Minute)); err != nil {
		t.Fatalf("cloud TouchUpdatedAt: %v", err)
	}
	if _, err := syncSvc.UploadConversation(ctx, localConv.ID, false); err == nil {
		t.Fatal("expected 409 conflict on upload after cloud edit")
	} else if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("expected ErrCodeConflict, got %v", err)
	}
	forcedUp, err := syncSvc.UploadConversation(ctx, localConv.ID, true)
	if err != nil || len(forcedUp.Messages) != 1 {
		t.Fatalf("expected forced upload to succeed with 1 local message, got err=%v msgs=%d", err, len(forcedUp.Messages))
	}

	// 2. Pull cloud conversation belonging to a cloud custom assistant -> mirrored locally & survives disconnect.
	customAsst, err := cloudAssistStore.Create(ctx, domain.Assistant{
		ID:   "cloud-asst-9",
		Name: "Cloud Helper",
	})
	if err != nil {
		t.Fatalf("create cloud assistant: %v", err)
	}
	cloudOnly, err := cloudConvStore.Create(ctx, domain.Conversation{
		ID:          "pull-1",
		AssistantID: customAsst.ID,
		Title:       "Cloud Original",
	})
	if err != nil {
		t.Fatalf("create cloudOnly conv: %v", err)
	}
	if _, err := cloudMsgStore.Create(ctx, domain.Message{
		ConversationID: cloudOnly.ID,
		Role:           domain.RoleUser,
		Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "iVBORw0KGgo="},
			{Type: domain.BlockTypeText, Text: "cloud text"},
		},
	}); err != nil {
		t.Fatalf("create cloud message: %v", err)
	}

	pullRes, err := syncSvc.PullConversation(ctx, cloudOnly.ID, false)
	if err != nil {
		t.Fatalf("PullConversation: %v", err)
	}
	if pullRes.Conversation.AssistantID != customAsst.ID || len(pullRes.Messages) != 1 {
		t.Fatalf("unexpected pull result: %+v", pullRes)
	}

	// Local pending edit triggers 409 conflict on pull unless forced.
	if err := localStore.MarkConversationPending(ctx, cloudOnly.ID); err != nil {
		t.Fatalf("MarkConversationPending: %v", err)
	}
	if _, err := syncSvc.PullConversation(ctx, cloudOnly.ID, false); err == nil {
		t.Fatal("expected 409 conflict on pull over locally modified conversation")
	}
	if _, err := syncSvc.PullConversation(ctx, cloudOnly.ID, true); err != nil {
		t.Fatalf("forced pull failed: %v", err)
	}

	// BatchTransfer continues past conflict on one item and succeeds on others.
	localTwo, _ := localStore.Conversations.Create(ctx, domain.Conversation{ID: "up-2", AssistantID: domain.DefaultAssistantID, Title: "Second"})
	_ = localStore.MarkConversationPending(ctx, cloudOnly.ID)
	batchRes, err := syncSvc.BatchTransfer(ctx, "upload", []string{localTwo.ID, "missing-conv"}, false)
	if err != nil {
		t.Fatalf("BatchTransfer: %v", err)
	}
	if len(batchRes.Succeeded) != 1 || batchRes.Succeeded[0] != localTwo.ID || len(batchRes.Failed) != 1 || batchRes.Failed[0].ID != "missing-conv" {
		t.Fatalf("unexpected batch transfer result: %+v", batchRes)
	}

	// Disconnect cloud -> pulled topic & image remain readable locally.
	_ = localStore.DisconnectCloud(ctx)
	cloud.SetCredentials("", "")
	offlineConv, err := localStore.Conversations.Get(ctx, cloudOnly.ID)
	offlineMsgs, mErr := localStore.Messages.ListByConversation(ctx, cloudOnly.ID)
	if err != nil || mErr != nil || offlineConv.Title != "Cloud Original" || len(offlineMsgs) != 1 || offlineMsgs[0].Blocks[0].Type != domain.BlockTypeImage {
		t.Fatalf("expected pulled conversation readable offline, conv=%+v msgs=%+v errs=%v/%v", offlineConv, offlineMsgs, err, mErr)
	}
}
