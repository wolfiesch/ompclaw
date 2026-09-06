#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int omp_openat(int parent_fd, const char *path, int flags) {
  return openat(parent_fd, path, flags);
}

int omp_openat_create(int parent_fd, const char *path, int flags, int mode) {
  return openat(parent_fd, path, flags, mode);
}

int omp_renameat(int old_parent_fd, const char *old_path, int new_parent_fd, const char *new_path) {
  return renameat(old_parent_fd, old_path, new_parent_fd, new_path);
}

int omp_unlinkat(int parent_fd, const char *path, int flags) {
  return unlinkat(parent_fd, path, flags);
}

int omp_errno(void) {
  return errno;
}

static unsigned char entry_type(int parent_fd, struct dirent *entry) {
  if (entry->d_type != DT_UNKNOWN) return entry->d_type;
  struct stat info;
  if (fstatat(parent_fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) return DT_UNKNOWN;
  if (S_ISDIR(info.st_mode)) return DT_DIR;
  if (S_ISLNK(info.st_mode)) return DT_LNK;
  return DT_REG;
}

int omp_list_directory_records(int parent_fd, char *output, int capacity) {
  int listing_fd = openat(parent_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (listing_fd < 0) return -1;
  DIR *directory = fdopendir(listing_fd);
  if (directory == NULL) {
    close(listing_fd);
    return -1;
  }

  int used = 0;
  int failed = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if ((entry->d_name[0] == '.' && entry->d_name[1] == '\0') ||
        (entry->d_name[0] == '.' && entry->d_name[1] == '.' && entry->d_name[2] == '\0')) {
      continue;
    }
    int length = (int)strlen(entry->d_name);
    int required = length + 2;
    if (used > 2147483647 - required || (output != NULL && used > capacity - required)) {
      errno = ENOBUFS;
      failed = 1;
      break;
    }
    if (output != NULL) {
      output[used] = (char)entry_type(parent_fd, entry);
      memcpy(output + used + 1, entry->d_name, length + 1);
    }
    used += required;
  }
  int read_error = errno;
  int close_error = closedir(directory);
  if (failed || read_error != 0 || close_error != 0) return -1;
  return used;
}
